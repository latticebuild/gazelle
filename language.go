package gazelle

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"maps"
	"path"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"connectrpc.com/connect"
	"github.com/bazel-contrib/bazel-gazelle/v2/label"
	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/language"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

var (
	_ language.Language            = (*Language)(nil)
	_ language.ModuleAwareLanguage = (*Language)(nil)
	_ language.LifecycleManager    = (*Language)(nil)
)

// Language is a Gazelle language whose semantics live in a plugin process.
// Run creates one per Plugin; the languages of a run share one session.
type Language struct {
	plugin  Plugin
	session *session
	process *process

	kinds      map[string]rule.KindInfo
	loads      []rule.LoadInfo
	directives map[string]bool // inherited, by name
	packages   map[string]bool
	ignored    bazelIgnore

	// provided caches the imports of each indexed BUILD file's rules by name.
	provided map[*rule.File]map[string][]resolve.ImportSpec
}

func (l *Language) Name() string { return l.plugin.Name }

// RegisterFlags registers nothing: plugins take their inputs as arguments.
func (*Language) RegisterFlags(*flag.FlagSet, string, *config.Config) {}

// CheckFlags starts the plugin and initializes the language. Gazelle calls it
// after parsing flags and before Kinds, Loads or the walk.
func (l *Language) CheckFlags(_ *flag.FlagSet, c *config.Config) error {
	proc, err := l.session.start(l.plugin, c.RepoRoot)
	if err != nil {
		return fmt.Errorf("%s: start plugin: %w", l.plugin.Name, err)
	}
	l.process = proc
	response, err := proc.client.Initialize(l.session.ctx, connect.NewRequest(&gazellev1.InitializeRequest{RepositoryRoot: c.RepoRoot}))
	if err != nil {
		return fmt.Errorf("%s: initialize: %s", l.plugin.Name, describe(err))
	}
	if err := l.initialize(response.Msg); err != nil {
		return fmt.Errorf("%s: initialize: %w", l.plugin.Name, err)
	}
	l.ignored = readBazelIgnore(c.RepoRoot)
	l.provided = map[*rule.File]map[string][]resolve.ImportSpec{}
	return nil
}

var attributeName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// initialize validates and records what the plugin declares.
func (l *Language) initialize(response *gazellev1.InitializeResponse) error {
	l.kinds = map[string]rule.KindInfo{}
	for _, kind := range response.GetKinds() {
		name := kind.GetName()
		if name == "" {
			return errors.New("a kind has no name")
		}
		if owner, taken := l.session.owners[name]; taken {
			return fmt.Errorf("kind %s is also declared by the %s language", name, owner)
		}
		info := rule.KindInfo{
			MergeableAttrs: map[string]bool{},
			ResolveAttrs:   map[string]bool{},
			NonEmptyAttrs:  map[string]bool{},
		}
		for _, set := range []struct {
			attributes []string
			into       map[string]bool
		}{
			{kind.GetMergeableAttributes(), info.MergeableAttrs},
			{kind.GetResolveAttributes(), info.ResolveAttrs},
			{kind.GetNonEmptyAttributes(), info.NonEmptyAttrs},
		} {
			for _, attribute := range set.attributes {
				if attribute == "name" || !attributeName.MatchString(attribute) {
					return fmt.Errorf("kind %s declares invalid attribute %q", name, attribute)
				}
				set.into[attribute] = true
			}
		}
		for attribute := range info.ResolveAttrs {
			if info.MergeableAttrs[attribute] {
				return fmt.Errorf("kind %s declares %s as both a mergeable and a resolve attribute", name, attribute)
			}
		}
		for attribute := range info.NonEmptyAttrs {
			if !info.MergeableAttrs[attribute] && !info.ResolveAttrs[attribute] {
				return fmt.Errorf("kind %s declares non-empty attribute %s, which it does not own", name, attribute)
			}
		}
		l.kinds[name] = info
		l.session.owners[name] = l.plugin.Name
	}
	l.loads = nil
	for _, load := range response.GetLoads() {
		if load.GetLabel() == "" || len(load.GetSymbols()) == 0 {
			return fmt.Errorf("load %q names no file or no symbols", load.GetLabel())
		}
		l.loads = append(l.loads, rule.LoadInfo{Name: load.GetLabel(), Symbols: load.GetSymbols()})
	}
	l.directives = map[string]bool{}
	for _, directive := range response.GetDirectives() {
		name := directive.GetName()
		if name == "" || strings.ContainsFunc(name, unicode.IsSpace) {
			return fmt.Errorf("invalid directive name %q", name)
		}
		if _, duplicate := l.directives[name]; duplicate {
			return fmt.Errorf("directive %s is declared twice", name)
		}
		l.directives[name] = directive.GetInherited()
	}
	l.packages = map[string]bool{}
	for _, pkg := range response.GetPackages() {
		if pkg != "" && (path.Clean(pkg) != pkg || path.IsAbs(pkg) || pkg == ".." || strings.HasPrefix(pkg, "../") || strings.Contains(pkg, `\`)) {
			return fmt.Errorf("package %q is not a slash-separated path relative to the repository root", pkg)
		}
		l.packages[pkg] = true
	}
	return nil
}

func (l *Language) KnownDirectives() []string {
	names := make([]string, 0, len(l.directives))
	for name := range l.directives {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// directives are the directive values in effect for one directory.
type directives struct {
	// effective lists every value in effect here, outermost first.
	effective []*gazellev1.DirectiveValue
	// inherited is the part of effective that subdirectories inherit.
	inherited []*gazellev1.DirectiveValue
}

// Configure records the language's directive values in c.Exts under the
// language name: inherited values from the parent directory followed by this
// BUILD file's values, of which only inherited ones pass to subdirectories.
func (l *Language) Configure(c *config.Config, rel string, f *rule.File) {
	parent, _ := c.Exts[l.plugin.Name].(directives)
	current := directives{effective: slices.Clip(parent.inherited), inherited: slices.Clip(parent.inherited)}
	if f != nil {
		for _, d := range f.Directives {
			if d.Key == "map_kind" {
				if from := strings.Fields(d.Value); len(from) > 0 {
					if _, owned := l.kinds[from[0]]; owned {
						l.fail(rel, fmt.Errorf("gazelle:map_kind %s: the %s language owns kind %s and cannot generate it under another name; remove the directive", d.Value, l.plugin.Name, from[0]))
					}
				}
				continue
			}
			inherited, known := l.directives[d.Key]
			if !known {
				continue
			}
			value := &gazellev1.DirectiveValue{Name: d.Key, Value: d.Value}
			current.effective = append(current.effective, value)
			if inherited {
				current.inherited = append(current.inherited, value)
			}
		}
	}
	c.Exts[l.plugin.Name] = current
}

func (l *Language) Kinds() map[string]rule.KindInfo { return l.kinds }

func (l *Language) Loads() []rule.LoadInfo { return l.loads }

// ApparentLoads returns the plugin's loads unchanged: plugins name load files
// by the apparent repository names this repository uses.
func (l *Language) ApparentLoads(func(string) string) []rule.LoadInfo { return l.loads }

// Fix does nothing: plugins own no deprecated usage to repair.
func (*Language) Fix(*config.Config, *rule.File) {}

// existingResolveAttributes is the private attribute of a generated rule that
// matched an existing rule. It holds the resolve attributes the existing rule
// still has after pre-cleaning, which Resolve may have to reduce.
const existingResolveAttributes = "_gazelle_existing_resolve_attributes"

// resolution is the Imports slot of a generated rule: its kind as the plugin
// generated it and its non-empty resolve attribute values, which may contain
// references.
type resolution struct {
	kind   string
	values map[string]*gazellev1.Value
}

// GenerateRules asks the plugin for a package's rules, pre-cleans the existing
// BUILD file and returns the rules with host mergers. It generates nothing in
// directories Initialize did not list.
func (l *Language) GenerateRules(args language.GenerateArgs) language.GenerateResult {
	if !l.packages[args.Rel] {
		return language.GenerateResult{}
	}
	files, excluded := l.inventory(args)
	request := &gazellev1.GenerateRequest{
		Package:       args.Rel,
		Files:         files,
		ExcludedPaths: excluded,
		Directives:    l.effective(args.Config),
		BuildFile:     buildFileOf(args.File),
	}
	response, err := l.process.client.Generate(l.session.ctx, connect.NewRequest(request))
	if err != nil {
		l.fail(args.Rel, errors.New(describe(err)))
		return language.GenerateResult{}
	}
	if err := l.checkGenerated(response.Msg); err != nil {
		l.fail(args.Rel, fmt.Errorf("invalid Generate response: %w", err))
		return language.GenerateResult{}
	}
	if args.File != nil {
		l.removeStale(args.File, response.Msg.GetStaleRules())
	}
	var result language.GenerateResult
	for _, generated := range response.Msg.GetRules() {
		r, values := l.newRule(generated)
		if !l.clean(args, r, values) {
			continue
		}
		result.Gen = append(result.Gen, r)
		result.Imports = append(result.Imports, resolution{kind: generated.GetKind(), values: values})
	}
	if args.File != nil {
		// A later language generating in this file sees the cleaned rules.
		args.File.Sync()
	}
	return result
}

func (l *Language) effective(c *config.Config) []*gazellev1.DirectiveValue {
	values, _ := c.Exts[l.plugin.Name].(directives)
	return values.effective
}

// checkGenerated validates a Generate response before anything changes.
func (l *Language) checkGenerated(response *gazellev1.GenerateResponse) error {
	generated := map[string]string{}
	for _, r := range response.GetRules() {
		info, known := l.kinds[r.GetKind()]
		switch {
		case !known:
			return fmt.Errorf("rule %q has kind %q, which Initialize did not declare", r.GetName(), r.GetKind())
		case !validName(r.GetName()):
			return fmt.Errorf("invalid rule name %q", r.GetName())
		}
		if _, duplicate := generated[r.GetName()]; duplicate {
			return fmt.Errorf("two rules are named %q", r.GetName())
		}
		generated[r.GetName()] = r.GetKind()
		for key, value := range r.GetAttributes() {
			if key == "name" || !attributeName.MatchString(key) {
				return fmt.Errorf("rule %q has invalid attribute %q", r.GetName(), key)
			}
			if err := checkValue(value, info.ResolveAttrs[key]); err != nil {
				return fmt.Errorf("rule %q attribute %s: %w", r.GetName(), key, err)
			}
		}
	}
	for _, stale := range response.GetStaleRules() {
		if _, known := l.kinds[stale.GetKind()]; !known {
			return fmt.Errorf("stale rule %q has kind %q, which Initialize did not declare", stale.GetName(), stale.GetKind())
		}
		if !validName(stale.GetName()) {
			return fmt.Errorf("invalid stale rule name %q", stale.GetName())
		}
		if generated[stale.GetName()] == stale.GetKind() {
			return fmt.Errorf("rule %s %q is both generated and stale", stale.GetKind(), stale.GetName())
		}
	}
	return nil
}

// validName accepts Bazel target names: normalized relative paths without
// ':', '\' or control characters.
func validName(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return !strings.ContainsFunc(name, func(r rune) bool { return r < ' ' || r == 0x7f || r == ':' || r == '\\' })
}

// newRule builds a generated rule: mergeable attributes wrapped in the host
// merger, attributes the kind does not own as plain values written only when
// the rule is created, and resolve attributes returned for the Imports slot.
// Empty values are omitted.
func (l *Language) newRule(generated *gazellev1.GeneratedRule) (*rule.Rule, map[string]*gazellev1.Value) {
	info := l.kinds[generated.GetKind()]
	r := rule.NewRule(generated.GetKind(), generated.GetName())
	values := map[string]*gazellev1.Value{}
	for _, key := range slices.Sorted(maps.Keys(generated.GetAttributes())) {
		value := generated.GetAttributes()[key]
		switch {
		case isEmpty(value):
		case info.ResolveAttrs[key]:
			values[key] = value
		case info.MergeableAttrs[key]:
			r.SetAttr(key, merger{exprOf(value)})
		default:
			r.SetAttr(key, exprOf(value))
		}
	}
	return r, values
}

// removeStale reduces the owned attributes of each stale existing rule that is
// not kept, and deletes the rule when none of its kind's non-empty attributes
// remain.
func (l *Language) removeStale(f *rule.File, stale []*gazellev1.RuleName) {
	for _, name := range stale {
		info := l.kinds[name.GetKind()]
		for _, r := range f.Rules {
			if r.Kind() != name.GetKind() || r.Name() != name.GetName() || r.ShouldKeep() {
				continue
			}
			for _, key := range r.AttrKeys() {
				if info.MergeableAttrs[key] || info.ResolveAttrs[key] {
					reduceAttr(r, key)
				}
			}
			if !slices.ContainsFunc(r.AttrKeys(), func(key string) bool { return info.NonEmptyAttrs[key] }) {
				r.Delete()
			}
		}
	}
	f.Sync()
}

// clean prepares the existing rule a generated rule will merge into. It
// reports false, after recording a diagnostic, when the name is taken by a
// rule of another kind or by another language's rule.
//
// Owned attributes the plugin no longer produces are reduced to their kept
// content, which the generated rule carries through a reducer so Gazelle's
// merge never sees the value. Present unowned attributes remain authored. Explicitly returned unowned
// attributes fill missing fields on existing rules.
func (l *Language) clean(args language.GenerateArgs, g *rule.Rule, values map[string]*gazellev1.Value) bool {
	for _, other := range args.OtherGen {
		if other.Name() == g.Name() {
			l.fail(args.Rel, fmt.Errorf("rule %q is generated both as %s by this language and as %s by another; one of them must change its name", g.Name(), g.Kind(), other.Kind()))
			return false
		}
	}
	if args.File == nil {
		return true
	}
	// Gazelle rejects a BUILD file in which two rules share a name.
	i := slices.IndexFunc(args.File.Rules, func(r *rule.Rule) bool { return r.Name() == g.Name() })
	if i < 0 {
		return true
	}
	existing := args.File.Rules[i]
	if existing.Kind() != g.Kind() {
		l.fail(args.Rel, fmt.Errorf("%s: rule %q is a %s, but the %s language generates %s %q; rename or remove the existing rule", args.File.Path, g.Name(), existing.Kind(), l.plugin.Name, g.Kind(), g.Name()))
		return false
	}
	if existing.ShouldKeep() {
		return true
	}
	info := l.kinds[g.Kind()]
	for _, key := range existing.AttrKeys() {
		absent := info.MergeableAttrs[key] && g.Attr(key) == nil || info.ResolveAttrs[key] && values[key] == nil
		if absent && reduceAttr(existing, key) && info.MergeableAttrs[key] {
			g.SetAttr(key, reducer{existing.Attr(key)})
		}
	}
	remaining := map[string]bool{}
	for key := range info.ResolveAttrs {
		if existing.Attr(key) != nil {
			remaining[key] = true
		}
	}
	g.SetPrivateAttr(existingResolveAttributes, remaining)
	for _, key := range g.AttrKeys() {
		if key != "name" && !info.MergeableAttrs[key] && (info.ResolveAttrs[key] || existing.Attr(key) != nil) {
			g.DelAttr(key)
		}
	}
	return true
}

// reduceAttr reduces an existing attribute to its kept content, deleting it
// when nothing kept remains. It reports whether reduced content remains; an
// attribute-level keep leaves the attribute untouched and reports false.
func reduceAttr(r *rule.Rule, key string) bool {
	if attrKept(r, key) {
		return false
	}
	kept := reduce(r.Attr(key))
	if kept == nil {
		r.DelAttr(key)
		return false
	}
	r.SetAttr(key, kept)
	return true
}

// Imports returns what an indexed rule provides. The first rule of a BUILD
// file asks the plugin about all of the file's rules of this language's
// kinds in one Index call.
func (l *Language) Imports(_ *config.Config, r *rule.Rule, f *rule.File) []resolve.ImportSpec {
	provided, cached := l.provided[f]
	if !cached {
		provided = l.index(f)
		l.provided[f] = provided
	}
	return provided[r.Name()]
}

func (l *Language) index(f *rule.File) map[string][]resolve.ImportSpec {
	request := &gazellev1.IndexRequest{Package: f.Pkg}
	names := map[string]bool{}
	for _, r := range f.Rules {
		if _, owned := l.kinds[r.Kind()]; owned {
			request.Rules = append(request.Rules, ruleOf(r))
			names[r.Name()] = true
		}
	}
	if len(request.Rules) == 0 {
		return nil
	}
	response, err := l.process.client.Index(l.session.ctx, connect.NewRequest(request))
	if err != nil {
		l.fail(f.Pkg, errors.New(describe(err)))
		return nil
	}
	provided := map[string][]resolve.ImportSpec{}
	for _, r := range response.Msg.GetRules() {
		if !names[r.GetName()] {
			l.fail(f.Pkg, fmt.Errorf("invalid Index response: no rule %q was indexed", r.GetName()))
			continue
		}
		specs := make([]resolve.ImportSpec, 0, len(r.GetImports()))
		for _, spec := range r.GetImports() {
			if spec.GetImport() == "" {
				l.fail(f.Pkg, fmt.Errorf("invalid Index response: rule %q provides an empty import", r.GetName()))
				continue
			}
			specs = append(specs, l.importSpec(spec))
		}
		provided[r.GetName()] = append(provided[r.GetName()], specs...)
	}
	return provided
}

// importSpec converts a protocol import spec; an empty language is this one.
func (l *Language) importSpec(spec *gazellev1.ImportSpec) resolve.ImportSpec {
	lang := spec.GetLanguage()
	if lang == "" {
		lang = l.plugin.Name
	}
	return resolve.ImportSpec{Lang: lang, Imp: spec.GetImport()}
}

// Embeds returns nil: plugin rules do not embed one another.
func (*Language) Embeds(*rule.Rule, label.Label) []label.Label { return nil }

func (*Language) Before(context.Context) {}

func (*Language) DoneGeneratingRules() {}

// AfterResolvingDeps runs after resolution and before Gazelle emits files. The
// first call stops every plugin of the run and collects their exit statuses;
// then any diagnostic stops the run with a panic that Run recovers, so Gazelle
// writes, prints and diffs nothing.
func (l *Language) AfterResolvingDeps(context.Context) {
	l.session.stop()
	if l.session.failed() {
		panic(abort{})
	}
}

// fail records a diagnostic for a package.
func (l *Language) fail(pkg string, err error) {
	l.session.report("%s: //%s: %v", l.plugin.Name, pkg, err)
}

// describe returns a plugin error's text: the plugin's message verbatim for
// invalid_argument, and the code and message otherwise.
func describe(err error) string {
	var rpcErr *connect.Error
	if errors.As(err, &rpcErr) && rpcErr.Code() == connect.CodeInvalidArgument {
		return rpcErr.Message()
	}
	return err.Error()
}
