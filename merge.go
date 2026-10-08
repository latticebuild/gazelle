package gazelle

import (
	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
	bzl "github.com/bazelbuild/buildtools/build"
)

// Gazelle's built-in value merge understands lists and selects keyed by Go
// platforms only; for a dict, a glob or another select it logs "could not
// merge expression" and keeps the stale value. Every owned attribute the host
// hands Gazelle is therefore wrapped in one of these mergers, so Gazelle's
// merge never inspects the value itself. Attribute-level `# keep` is handled
// by Gazelle before a merger is consulted.
var (
	_ rule.Merger       = merger{}
	_ rule.BzlExprValue = merger{}
	_ rule.Merger       = reducer{}
	_ rule.BzlExprValue = reducer{}
)

// merger merges a new, non-empty value into an existing one. It never returns
// nil, so Gazelle never deletes an attribute that has a new value.
type merger struct{ value bzl.Expr }

func (m merger) BzlExpr() bzl.Expr           { return m.value }
func (m merger) Merge(old bzl.Expr) bzl.Expr { return merge(m.value, old) }

// merge merges value into old. A dict keeps kept entries and the comments of
// matched keys. Lists, selects, globs and their concatenations merge part by
// part: a list through mergeList, in the new order, keeping matched items'
// comments and kept items; a select per condition, for any condition label;
// other parts, such as globs, replace what they meet. Kept content of old parts
// that no new part matched follows the new parts. Scalars are replaced.
func merge(value, old bzl.Expr) bzl.Expr {
	if old == nil {
		return value
	}
	switch value := value.(type) {
	case *bzl.DictExpr:
		if old, ok := old.(*bzl.DictExpr); ok {
			return mergeDict(value, old)
		}
		return value
	case *bzl.ListExpr, *bzl.CallExpr, *bzl.BinaryExpr:
		if merged := mergeParts(value, old); merged != nil {
			return merged
		}
	}
	return value
}

// mergeParts merges the operands of a concatenation: each new list with the
// first unused old list, each new select with the first unused old select.
// Old operands left over contribute only their kept content.
func mergeParts(value, old bzl.Expr) bzl.Expr {
	previous := operands(old)
	used := make([]bool, len(previous))
	take := func(match func(bzl.Expr) bool) bzl.Expr {
		for i, part := range previous {
			if !used[i] && match(part) {
				used[i] = true
				return part
			}
		}
		return nil
	}
	var parts []bzl.Expr
	for _, part := range operands(value) {
		switch {
		case isList(part):
			list := part.(*bzl.ListExpr)
			if old, ok := take(isList).(*bzl.ListExpr); ok {
				// mergeList returns nil for an empty new list with nothing kept.
				if merged := mergeList(list, old); merged != nil {
					parts = append(parts, merged)
				}
			} else {
				parts = append(parts, list)
			}
		case isSelect(part):
			if old := take(isSelect); old != nil {
				parts = append(parts, mergeSelect(part.(*bzl.CallExpr), old.(*bzl.CallExpr)))
			} else {
				parts = append(parts, part)
			}
		default:
			parts = append(parts, part)
		}
	}
	for i, part := range previous {
		if !used[i] {
			if kept := reduce(part); kept != nil {
				parts = append(parts, kept)
			}
		}
	}
	return concat(parts)
}

// mergeList merges a new list into an old one. Unlike rule.MergeList, which
// keeps the old order of the items both hold, the plugin's order wins: some
// attributes depend on it, such as a tsconfig's extends, whose later bases
// override earlier ones. An item both hold keeps the old item and its
// comments, and a kept item the new list lacks stays after the item it
// followed.
func mergeList(value, old *bzl.ListExpr) *bzl.ListExpr {
	listed := make(map[string]bool)
	for _, item := range value.List {
		if s, ok := item.(*bzl.StringExpr); ok {
			listed[s.Value] = true
		}
	}
	// Old items the new list holds, and the kept ones it lacks by the listed
	// item they followed ("" before any).
	previous := make(map[string]bzl.Expr)
	kept := make(map[string][]bzl.Expr)
	anchor := ""
	keepComment := false
	for _, item := range old.List {
		if s, ok := item.(*bzl.StringExpr); ok && listed[s.Value] {
			previous[s.Value] = item
			anchor = s.Value
		} else if rule.ShouldKeep(item) {
			keepComment = true
			kept[anchor] = append(kept[anchor], item)
		}
	}
	merged := kept[""]
	for _, item := range value.List {
		s, ok := item.(*bzl.StringExpr)
		if !ok {
			merged = append(merged, item)
			continue
		}
		if match, ok := previous[s.Value]; ok {
			keepComment = keepComment || rule.ShouldKeep(match)
			item = match
			delete(previous, s.Value)
		}
		merged = append(merged, item)
		merged = append(merged, kept[s.Value]...)
		delete(kept, s.Value)
	}
	if len(merged) == 0 {
		return nil
	}
	return &bzl.ListExpr{
		List:           merged,
		ForceMultiLine: value.ForceMultiLine || old.ForceMultiLine || keepComment,
	}
}

func isList(e bzl.Expr) bool {
	_, ok := e.(*bzl.ListExpr)
	return ok
}

func isSelect(e bzl.Expr) bool {
	_, ok := selectDict(e)
	return ok
}

// mergeSelect merges a select per condition. A kept old condition stays as it
// was; an old condition absent from the new value keeps its kept items.
func mergeSelect(value, old *bzl.CallExpr) bzl.Expr {
	cases, _ := selectDict(value)
	oldCases, _ := selectDict(old)
	previous := map[string]*bzl.KeyValueExpr{}
	for _, kv := range oldCases.List {
		if _, duplicate := previous[condition(kv)]; !duplicate {
			previous[condition(kv)] = kv
		}
	}
	var merged []*bzl.KeyValueExpr
	for _, kv := range cases.List {
		oldCase, matched := previous[condition(kv)]
		delete(previous, condition(kv))
		switch {
		case !matched:
			merged = append(merged, kv)
		case entryKept(oldCase):
			merged = append(merged, oldCase)
		default:
			merged = append(merged, &bzl.KeyValueExpr{Key: oldCase.Key, Value: merge(kv.Value, oldCase.Value), Comments: oldCase.Comments})
		}
	}
	for _, kv := range oldCases.List {
		if previous[condition(kv)] != kv {
			continue
		}
		if entryKept(kv) {
			merged = append(merged, kv)
		} else if kept := reduce(kv.Value); kept != nil {
			merged = append(merged, &bzl.KeyValueExpr{Key: kv.Key, Value: kept, Comments: kv.Comments})
		}
	}
	return &bzl.CallExpr{
		X:        value.X,
		List:     []bzl.Expr{&bzl.DictExpr{List: defaultLast(merged), ForceMultiLine: true}},
		Comments: old.Comments,
	}
}

// defaultLast moves the //conditions:default case to the end.
func defaultLast(cases []*bzl.KeyValueExpr) []*bzl.KeyValueExpr {
	var ordered []*bzl.KeyValueExpr
	var fallback *bzl.KeyValueExpr
	for _, kv := range cases {
		if condition(kv) == "//conditions:default" {
			fallback = kv
		} else {
			ordered = append(ordered, kv)
		}
	}
	if fallback != nil {
		ordered = append(ordered, fallback)
	}
	return ordered
}

// mergeDict merges a dict by key: matched keys keep their old comments (or the
// whole old entry when it is kept), and kept old entries whose keys the new
// value lacks follow the new entries.
func mergeDict(value, old *bzl.DictExpr) bzl.Expr {
	previous := map[string]*bzl.KeyValueExpr{}
	for _, kv := range old.List {
		key := bzl.FormatString(kv.Key)
		if _, duplicate := previous[key]; !duplicate {
			previous[key] = kv
		}
	}
	merged := &bzl.DictExpr{ForceMultiLine: value.ForceMultiLine || old.ForceMultiLine, Comments: old.Comments}
	for _, kv := range value.List {
		key := bzl.FormatString(kv.Key)
		oldEntry, matched := previous[key]
		delete(previous, key)
		switch {
		case !matched:
			merged.List = append(merged.List, kv)
		case entryKept(oldEntry):
			merged.List = append(merged.List, oldEntry)
		default:
			merged.List = append(merged.List, &bzl.KeyValueExpr{Key: oldEntry.Key, Value: merge(kv.Value, oldEntry.Value), Comments: oldEntry.Comments})
		}
	}
	for _, kv := range old.List {
		if previous[bzl.FormatString(kv.Key)] == kv && entryKept(kv) {
			merged.List = append(merged.List, kv)
		}
	}
	return merged
}

// reducer merges an owned attribute that has no new value into its existing
// value by reducing it to its kept content; it returns nil, which deletes the
// attribute, when nothing kept remains. value is the syntax Gazelle sees for
// the generated attribute; it is written only if the rule is created.
type reducer struct{ value bzl.Expr }

func (r reducer) BzlExpr() bzl.Expr {
	if r.value == nil {
		return &bzl.ListExpr{}
	}
	return r.value
}

func (reducer) Merge(old bzl.Expr) bzl.Expr { return reduce(old) }

// reduce keeps only an expression's `# keep` content: kept list items, kept
// dict entries, kept select conditions and the kept items of other
// conditions, and kept operands of a concatenation. A select that keeps any
// condition also keeps its default, emptied when nothing in it is kept. It
// returns nil when nothing kept remains.
func reduce(e bzl.Expr) bzl.Expr {
	if e == nil {
		return nil
	}
	if rule.ShouldKeep(e) {
		return e
	}
	switch e := e.(type) {
	case *bzl.ListExpr:
		var kept []bzl.Expr
		for _, item := range e.List {
			if rule.ShouldKeep(item) {
				kept = append(kept, item)
			}
		}
		if len(kept) == 0 {
			return nil
		}
		return &bzl.ListExpr{List: kept, ForceMultiLine: true, Comments: e.Comments}
	case *bzl.DictExpr:
		var kept []*bzl.KeyValueExpr
		for _, kv := range e.List {
			if entryKept(kv) {
				kept = append(kept, kv)
			}
		}
		if len(kept) == 0 {
			return nil
		}
		return &bzl.DictExpr{List: kept, ForceMultiLine: e.ForceMultiLine, Comments: e.Comments}
	case *bzl.CallExpr:
		return reduceSelect(e)
	case *bzl.BinaryExpr:
		if e.Op != "+" {
			return nil
		}
		var kept []bzl.Expr
		for _, operand := range operands(e) {
			if part := reduce(operand); part != nil {
				kept = append(kept, part)
			}
		}
		return concat(kept)
	}
	return nil
}

func reduceSelect(call *bzl.CallExpr) bzl.Expr {
	cases, ok := selectDict(call)
	if !ok {
		return nil
	}
	var kept []*bzl.KeyValueExpr
	var fallback *bzl.KeyValueExpr
	for _, kv := range cases.List {
		reduced := kv
		if !entryKept(kv) {
			value := reduce(kv.Value)
			if value == nil {
				reduced = nil
			} else {
				reduced = &bzl.KeyValueExpr{Key: kv.Key, Value: value, Comments: kv.Comments}
			}
		}
		switch {
		case condition(kv) == "//conditions:default":
			fallback = kv
			if reduced != nil {
				kept = append(kept, reduced)
				fallback = nil
			}
		case reduced != nil:
			kept = append(kept, reduced)
		}
	}
	if len(kept) == 0 {
		return nil
	}
	if fallback != nil {
		// A select without a default fails on every other configuration.
		empty := fallback.Value
		if isList(empty) {
			empty = &bzl.ListExpr{}
		}
		kept = append(kept, &bzl.KeyValueExpr{Key: fallback.Key, Value: empty, Comments: fallback.Comments})
	}
	return &bzl.CallExpr{
		X:        call.X,
		List:     []bzl.Expr{&bzl.DictExpr{List: defaultLast(kept), ForceMultiLine: true}},
		Comments: call.Comments,
	}
}
