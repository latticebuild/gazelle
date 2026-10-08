package gazelle

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"

	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
	bzl "github.com/bazelbuild/buildtools/build"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
)

// buildFileOf converts an existing BUILD file to the plain-value view, or
// returns nil when the package has no BUILD file.
func buildFileOf(f *rule.File) *gazellev1.BuildFile {
	if f == nil {
		return nil
	}
	file := &gazellev1.BuildFile{Name: filepath.Base(f.Path)}
	for _, r := range f.Rules {
		file.Rules = append(file.Rules, ruleOf(r))
	}
	return file
}

// ruleOf converts an existing rule to the plain-value view. Positional
// arguments are not part of the view.
func ruleOf(r *rule.Rule) *gazellev1.Rule {
	view := &gazellev1.Rule{
		Kind:       r.Kind(),
		Name:       r.Name(),
		Attributes: map[string]*gazellev1.Attribute{},
		Kept:       r.ShouldKeep(),
	}
	for _, key := range r.AttrKeys() {
		if key == "name" {
			continue
		}
		view.Attributes[key] = &gazellev1.Attribute{Value: valueOf(r.Attr(key)), Kept: attrKept(r, key)}
	}
	return view
}

// attrKept reports whether an attribute carries `# keep` on its assignment or
// on its whole value.
func attrKept(r *rule.Rule, key string) bool {
	comments := r.AttrComments(key)
	return comments != nil && rule.ShouldKeep(&bzl.AssignExpr{Comments: *comments}) || rule.ShouldKeep(r.Attr(key))
}

// entryKept reports whether a dict entry or select condition carries
// `# keep`.
func entryKept(kv *bzl.KeyValueExpr) bool {
	return rule.ShouldKeep(kv) || rule.ShouldKeep(kv.Key) || rule.ShouldKeep(kv.Value)
}

// valueOf converts an existing expression to a plain value. Expressions the
// protocol cannot represent become Opaque, carrying their source for
// diagnostics.
func valueOf(e bzl.Expr) *gazellev1.Value {
	switch e := e.(type) {
	case *bzl.StringExpr:
		return stringValue(e.Value)
	case *bzl.LiteralExpr:
		if n, err := strconv.ParseInt(e.Token, 0, 64); err == nil {
			return &gazellev1.Value{Value: &gazellev1.Value_IntValue{IntValue: n}}
		}
	case *bzl.UnaryExpr:
		if literal, ok := e.X.(*bzl.LiteralExpr); ok && e.Op == "-" {
			if n, err := strconv.ParseInt("-"+literal.Token, 0, 64); err == nil {
				return &gazellev1.Value{Value: &gazellev1.Value_IntValue{IntValue: n}}
			}
		}
	case *bzl.Ident:
		switch e.Name {
		case "True", "False":
			return &gazellev1.Value{Value: &gazellev1.Value_BoolValue{BoolValue: e.Name == "True"}}
		case "None":
			return &gazellev1.Value{Value: &gazellev1.Value_NullValue{NullValue: &gazellev1.Null{}}}
		}
	case *bzl.ListExpr:
		list := &gazellev1.List{}
		for _, item := range e.List {
			list.Items = append(list.Items, valueOf(item))
			list.Kept = append(list.Kept, rule.ShouldKeep(item))
		}
		return &gazellev1.Value{Value: &gazellev1.Value_List{List: list}}
	case *bzl.DictExpr:
		dict := &gazellev1.Dict{}
		for _, kv := range e.List {
			dict.Entries = append(dict.Entries, &gazellev1.DictEntry{Key: valueOf(kv.Key), Value: valueOf(kv.Value), Kept: entryKept(kv)})
		}
		return &gazellev1.Value{Value: &gazellev1.Value_Dict{Dict: dict}}
	case *bzl.CallExpr:
		if dict, ok := selectDict(e); ok {
			selection := &gazellev1.Select{}
			for _, kv := range dict.List {
				selection.Cases = append(selection.Cases, &gazellev1.SelectCase{Condition: condition(kv), Value: valueOf(kv.Value)})
			}
			return &gazellev1.Value{Value: &gazellev1.Value_Select{Select: selection}}
		}
		if glob, ok := globOf(e); ok {
			return &gazellev1.Value{Value: &gazellev1.Value_Glob{Glob: glob}}
		}
	case *bzl.BinaryExpr:
		if e.Op == "+" {
			concatenation := &gazellev1.Concatenation{}
			for _, operand := range operands(e) {
				concatenation.Operands = append(concatenation.Operands, valueOf(operand))
			}
			return &gazellev1.Value{Value: &gazellev1.Value_Concatenation{Concatenation: concatenation}}
		}
	}
	return &gazellev1.Value{Value: &gazellev1.Value_Opaque{Opaque: &gazellev1.Opaque{Source: bzl.FormatString(e)}}}
}

func stringValue(s string) *gazellev1.Value {
	return &gazellev1.Value{Value: &gazellev1.Value_StringValue{StringValue: s}}
}

// selectDict returns the dict of a select call whose conditions are all
// string literals.
func selectDict(e bzl.Expr) (*bzl.DictExpr, bool) {
	call, ok := e.(*bzl.CallExpr)
	if !ok || len(call.List) != 1 {
		return nil, false
	}
	if name, ok := call.X.(*bzl.Ident); !ok || name.Name != "select" {
		return nil, false
	}
	dict, ok := call.List[0].(*bzl.DictExpr)
	if !ok {
		return nil, false
	}
	for _, kv := range dict.List {
		if _, ok := kv.Key.(*bzl.StringExpr); !ok {
			return nil, false
		}
	}
	return dict, true
}

// condition returns the label of a select case built by selectDict.
func condition(kv *bzl.KeyValueExpr) string {
	return kv.Key.(*bzl.StringExpr).Value
}

// globOf reads glob(include, exclude, allow_empty = ...) with literal string
// lists and a literal boolean. Any other argument makes the call opaque.
func globOf(call *bzl.CallExpr) (*gazellev1.Glob, bool) {
	if name, ok := call.X.(*bzl.Ident); !ok || name.Name != "glob" {
		return nil, false
	}
	glob := &gazellev1.Glob{}
	seen := map[string]bool{}
	positional := []string{"include", "exclude"}
	for i, arg := range call.List {
		key, value := "", arg
		if assign, ok := arg.(*bzl.AssignExpr); ok {
			name, _ := assign.LHS.(*bzl.Ident)
			if name == nil {
				return nil, false
			}
			key, value = name.Name, assign.RHS
		} else if i < len(positional) && len(seen) == i {
			key = positional[i]
		}
		if seen[key] {
			return nil, false
		}
		seen[key] = true
		var ok bool
		switch key {
		case "include":
			glob.Include, ok = stringsOf(value)
		case "exclude":
			glob.Exclude, ok = stringsOf(value)
		case "allow_empty":
			var name *bzl.Ident
			name, ok = value.(*bzl.Ident)
			if ok && (name.Name == "True" || name.Name == "False") {
				allow := name.Name == "True"
				glob.AllowEmpty = &allow
			} else {
				ok = false
			}
		}
		if !ok {
			return nil, false
		}
	}
	return glob, true
}

func stringsOf(e bzl.Expr) ([]string, bool) {
	list, ok := e.(*bzl.ListExpr)
	if !ok {
		return nil, false
	}
	values := make([]string, 0, len(list.List))
	for _, item := range list.List {
		s, ok := item.(*bzl.StringExpr)
		if !ok {
			return nil, false
		}
		values = append(values, s.Value)
	}
	return values, true
}

// operands flattens a chain of `+` into its operands.
func operands(e bzl.Expr) []bzl.Expr {
	if sum, ok := e.(*bzl.BinaryExpr); ok && sum.Op == "+" {
		return append(operands(sum.X), operands(sum.Y)...)
	}
	return []bzl.Expr{e}
}

// exprOf converts a generated value to syntax. Callers resolve references and
// reject opaque values first.
func exprOf(v *gazellev1.Value) bzl.Expr {
	switch x := v.GetValue().(type) {
	case *gazellev1.Value_StringValue:
		return &bzl.StringExpr{Value: x.StringValue}
	case *gazellev1.Value_IntValue:
		return &bzl.LiteralExpr{Token: strconv.FormatInt(x.IntValue, 10)}
	case *gazellev1.Value_BoolValue:
		if x.BoolValue {
			return &bzl.Ident{Name: "True"}
		}
		return &bzl.Ident{Name: "False"}
	case *gazellev1.Value_NullValue:
		return &bzl.Ident{Name: "None"}
	case *gazellev1.Value_List:
		list := &bzl.ListExpr{}
		for _, item := range x.List.GetItems() {
			list.List = append(list.List, exprOf(item))
		}
		return list
	case *gazellev1.Value_Dict:
		dict := &bzl.DictExpr{ForceMultiLine: len(x.Dict.GetEntries()) > 0}
		for _, entry := range x.Dict.GetEntries() {
			dict.List = append(dict.List, &bzl.KeyValueExpr{Key: exprOf(entry.GetKey()), Value: exprOf(entry.GetValue())})
		}
		return dict
	case *gazellev1.Value_Glob:
		call := &bzl.CallExpr{X: &bzl.Ident{Name: "glob"}, List: []bzl.Expr{stringList(x.Glob.GetInclude())}}
		if exclude := x.Glob.GetExclude(); len(exclude) > 0 {
			call.List = append(call.List, keyword("exclude", stringList(exclude)))
		}
		if x.Glob.AllowEmpty != nil {
			call.List = append(call.List, keyword("allow_empty", exprOf(&gazellev1.Value{Value: &gazellev1.Value_BoolValue{BoolValue: x.Glob.GetAllowEmpty()}})))
		}
		return call
	case *gazellev1.Value_Select:
		dict := &bzl.DictExpr{ForceMultiLine: true}
		for _, c := range x.Select.GetCases() {
			dict.List = append(dict.List, &bzl.KeyValueExpr{Key: &bzl.StringExpr{Value: c.GetCondition()}, Value: exprOf(c.GetValue())})
		}
		return &bzl.CallExpr{X: &bzl.Ident{Name: "select"}, List: []bzl.Expr{dict}}
	case *gazellev1.Value_Concatenation:
		parts := make([]bzl.Expr, 0, len(x.Concatenation.GetOperands()))
		for _, operand := range x.Concatenation.GetOperands() {
			parts = append(parts, exprOf(operand))
		}
		return concat(parts)
	}
	panic(fmt.Sprintf("gazelle: %T has no syntax; references must be resolved and opaque values rejected first", v.GetValue()))
}

func stringList(values []string) *bzl.ListExpr {
	list := &bzl.ListExpr{}
	for _, v := range values {
		list.List = append(list.List, &bzl.StringExpr{Value: v})
	}
	return list
}

func keyword(name string, value bzl.Expr) *bzl.AssignExpr {
	return &bzl.AssignExpr{LHS: &bzl.Ident{Name: name}, Op: "=", RHS: value}
}

// concat joins parts with `+`, or returns nil when there are none.
func concat(parts []bzl.Expr) bzl.Expr {
	var sum bzl.Expr
	for _, part := range parts {
		if sum == nil {
			sum = part
		} else {
			sum = &bzl.BinaryExpr{X: sum, Op: "+", Y: part}
		}
	}
	return sum
}

// isEmpty reports whether a value is an empty list or dict, a select whose
// branches are all empty, or a concatenation of empty values. The host omits
// such values; an omitted owned attribute counts as absent.
func isEmpty(v *gazellev1.Value) bool {
	switch x := v.GetValue().(type) {
	case *gazellev1.Value_List:
		return len(x.List.GetItems()) == 0
	case *gazellev1.Value_Dict:
		return len(x.Dict.GetEntries()) == 0
	case *gazellev1.Value_Select:
		for _, c := range x.Select.GetCases() {
			if !isEmpty(c.GetValue()) {
				return false
			}
		}
		return true
	case *gazellev1.Value_Concatenation:
		for _, operand := range x.Concatenation.GetOperands() {
			if !isEmpty(operand) {
				return false
			}
		}
		return true
	}
	return false
}

// checkValue validates a generated value. References are allowed only where
// the host resolves them.
func checkValue(v *gazellev1.Value, references bool) error {
	switch x := v.GetValue().(type) {
	case nil:
		return errors.New("a value is unset")
	case *gazellev1.Value_List:
		for _, item := range x.List.GetItems() {
			if err := checkValue(item, references); err != nil {
				return err
			}
		}
	case *gazellev1.Value_Dict:
		for _, entry := range x.Dict.GetEntries() {
			if err := checkValue(entry.GetKey(), references); err != nil {
				return err
			}
			if err := checkValue(entry.GetValue(), references); err != nil {
				return err
			}
		}
	case *gazellev1.Value_Select:
		for _, c := range x.Select.GetCases() {
			if c.GetCondition() == "" {
				return errors.New("a select case has no condition")
			}
			if err := checkValue(c.GetValue(), references); err != nil {
				return err
			}
		}
	case *gazellev1.Value_Concatenation:
		if len(x.Concatenation.GetOperands()) < 2 {
			return errors.New("a concatenation has fewer than two operands")
		}
		for _, operand := range x.Concatenation.GetOperands() {
			if err := checkValue(operand, references); err != nil {
				return err
			}
		}
	case *gazellev1.Value_Reference:
		if !references {
			return errors.New("references are allowed only in the kind's resolve attributes")
		}
		if x.Reference.GetSpec().GetImport() == "" {
			return errors.New("a reference has no import")
		}
	case *gazellev1.Value_Opaque:
		return errors.New("opaque values are allowed only in existing rules")
	}
	return nil
}
