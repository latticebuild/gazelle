package gazelle

import (
	"fmt"
	"maps"
	"slices"
	"strings"

	"github.com/bazel-contrib/bazel-gazelle/v2/label"
	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
	"github.com/bazelbuild/bazel-gazelle/config"
	"github.com/bazelbuild/bazel-gazelle/repo"
	"github.com/bazelbuild/bazel-gazelle/resolve"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

// Resolve sets a generated rule's resolve attributes after indexing. Every
// non-empty resolved value goes through the host merger, because a plain value
// would fall back to Gazelle's Go-platform merge and keep stale selects. A
// value that resolves to nothing is omitted, unless the existing rule still has
// the attribute: then a reducer keeps only its kept content, since this is the
// last merge pass.
func (l *Language) Resolve(c *config.Config, ix *resolve.RuleIndex, _ *repo.RemoteCache, r *rule.Rule, imports any, from label.Label) {
	generated, ok := imports.(resolution)
	if !ok {
		return
	}
	info := l.kinds[generated.kind]
	existing, _ := r.PrivateAttr(existingResolveAttributes).(map[string]bool)
	for _, key := range slices.Sorted(maps.Keys(info.ResolveAttrs)) {
		var resolved *gazellev1.Value
		if value := generated.values[key]; value != nil {
			resolved = l.resolveValue(c, ix, from, value)
		}
		switch {
		case resolved != nil && !isEmpty(resolved):
			r.SetAttr(key, merger{exprOf(resolved)})
		case existing[key]:
			r.SetAttr(key, reducer{})
		}
	}
}

// resolveValue replaces the references in v with labels. A reference that
// resolves to nothing, such as a self-import, drops out of its list, dict
// entry, select case or concatenation; resolveValue returns nil when v itself
// drops out.
func (l *Language) resolveValue(c *config.Config, ix *resolve.RuleIndex, from label.Label, v *gazellev1.Value) *gazellev1.Value {
	switch x := v.GetValue().(type) {
	case *gazellev1.Value_Reference:
		target, ok := l.resolveReference(c, ix, from, x.Reference)
		if !ok {
			return nil
		}
		return stringValue(target)
	case *gazellev1.Value_List:
		list := &gazellev1.List{}
		for _, item := range x.List.GetItems() {
			if resolved := l.resolveValue(c, ix, from, item); resolved != nil {
				list.Items = append(list.Items, resolved)
			}
		}
		return &gazellev1.Value{Value: &gazellev1.Value_List{List: list}}
	case *gazellev1.Value_Dict:
		dict := &gazellev1.Dict{}
		for _, entry := range x.Dict.GetEntries() {
			key := l.resolveValue(c, ix, from, entry.GetKey())
			value := l.resolveValue(c, ix, from, entry.GetValue())
			if key != nil && value != nil {
				dict.Entries = append(dict.Entries, &gazellev1.DictEntry{Key: key, Value: value})
			}
		}
		return &gazellev1.Value{Value: &gazellev1.Value_Dict{Dict: dict}}
	case *gazellev1.Value_Select:
		selection := &gazellev1.Select{}
		for _, branch := range x.Select.GetCases() {
			if value := l.resolveValue(c, ix, from, branch.GetValue()); value != nil {
				selection.Cases = append(selection.Cases, &gazellev1.SelectCase{Condition: branch.GetCondition(), Value: value})
			}
		}
		return &gazellev1.Value{Value: &gazellev1.Value_Select{Select: selection}}
	case *gazellev1.Value_Concatenation:
		var parts []*gazellev1.Value
		for _, operand := range x.Concatenation.GetOperands() {
			if resolved := l.resolveValue(c, ix, from, operand); resolved != nil {
				parts = append(parts, resolved)
			}
		}
		switch len(parts) {
		case 0:
			return nil
		case 1:
			return parts[0]
		}
		return &gazellev1.Value{Value: &gazellev1.Value_Concatenation{Concatenation: &gazellev1.Concatenation{Operands: parts}}}
	}
	return v
}

// resolveReference finds the rule that provides a reference's import:
// a gazelle:resolve override first, then the rule index. A self-import
// resolves to nothing. Exactly one provider wins; none uses the fallback
// label or is a diagnostic, and several are a diagnostic. Labels are relative
// to the consuming package.
func (l *Language) resolveReference(c *config.Config, ix *resolve.RuleIndex, from label.Label, ref *gazellev1.Reference) (string, bool) {
	spec := l.importSpec(ref.GetSpec())
	if target, ok := resolve.FindRuleWithOverride(c, spec, l.plugin.Name); ok {
		if target.Equal(from) {
			return "", false
		}
		return target.Rel(c.RepoName, from.Pkg).String(), true
	}
	var providers []label.Label
	for _, match := range ix.FindRulesByImportWithConfig(c, spec, l.plugin.Name) {
		if match.IsSelfImport(from) {
			return "", false
		}
		providers = append(providers, match.Label)
	}
	switch {
	case len(providers) == 1:
		return providers[0].Rel(c.RepoName, from.Pkg).String(), true
	case len(providers) > 1:
		names := make([]string, len(providers))
		for i, provider := range providers {
			names[i] = provider.Rel(c.RepoName, from.Pkg).String()
		}
		l.fail(from.Pkg, fmt.Errorf("rule %q: %s import %q is provided by %s; add a gazelle:resolve directive to choose one", from.Name, spec.Lang, spec.Imp, strings.Join(names, ", ")))
		return "", false
	case ref.GetFallback() == "":
		l.fail(from.Pkg, fmt.Errorf("rule %q: no rule provides %s import %q; add a rule that provides it or a gazelle:resolve directive", from.Name, spec.Lang, spec.Imp))
		return "", false
	}
	fallback, err := label.Parse(ref.GetFallback())
	if err != nil {
		l.fail(from.Pkg, fmt.Errorf("rule %q: fallback label for %s import %q: %w", from.Name, spec.Lang, spec.Imp, err))
		return "", false
	}
	if fallback.Repo == "" && !fallback.Relative {
		fallback.Repo = c.RepoName
	}
	return fallback.Abs(c.RepoName, from.Pkg).Rel(c.RepoName, from.Pkg).String(), true
}
