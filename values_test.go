package gazelle

import (
	"strings"
	"testing"

	"github.com/bazel-contrib/bazel-gazelle/v2/rule"
	bzl "github.com/bazelbuild/buildtools/build"
	gazellev1 "github.com/latticebuild/gazelle/generated/gazelle/v1"
	"google.golang.org/protobuf/encoding/prototext"
	"google.golang.org/protobuf/proto"
)

// parseExpr parses one Starlark expression, keeping its comments.
func parseExpr(t *testing.T, source string) bzl.Expr {
	t.Helper()
	f, err := bzl.ParseBuild("BUILD.bazel", []byte("x = "+source+"\n"))
	if err != nil {
		t.Fatalf("parse %s: %v", source, err)
	}
	return f.Stmt[0].(*bzl.AssignExpr).RHS
}

func TestValueRoundTripsRepresentableExpressions(t *testing.T) {
	for _, tc := range []struct {
		name   string
		source string
	}{
		{"string", `"src/lib.rs"`},
		{"int", `42`},
		{"negative int", `-7`},
		{"true", `True`},
		{"false", `False`},
		{"none", `None`},
		{"list", `["a", "b"]`},
		{"dict", `{"key": "value", "other": ["x"]}`},
		{"glob", `glob(["src/**/*.rs"])`},
		{"glob with exclude and allow_empty", `glob(["**/*.ts"], exclude = ["**/*.test.ts"], allow_empty = True)`},
		{"select with non-Go conditions", `select({"@crates_io//:aarch64-apple-darwin": ["//a"], "//conditions:default": []})`},
		{"concatenation", `["a"] + select({
    "//c:x": ["b"],
}) + glob(["*.txt"])`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			expr := parseExpr(t, tc.source)
			value := valueOf(expr)
			if opaque := value.GetOpaque(); opaque != nil {
				t.Fatalf("valueOf(%s) is opaque", tc.source)
			}
			if got, want := bzl.FormatString(exprOf(value)), bzl.FormatString(expr); got != want {
				t.Errorf("round trip of %s = %s", want, got)
			}
		})
	}
}

func TestValueOfCarriesKeepFlags(t *testing.T) {
	expr := parseExpr(t, `{
    "kept": [
        "a",  # keep
        "b",
    ],
    "plain": "c",
    # keep
    "entry": "d",
}`)
	want := &gazellev1.Value{Value: &gazellev1.Value_Dict{Dict: &gazellev1.Dict{Entries: []*gazellev1.DictEntry{
		{Key: stringValue("kept"), Value: &gazellev1.Value{Value: &gazellev1.Value_List{List: &gazellev1.List{
			Items: []*gazellev1.Value{stringValue("a"), stringValue("b")},
			Kept:  []bool{true, false},
		}}}},
		{Key: stringValue("plain"), Value: stringValue("c")},
		{Key: stringValue("entry"), Value: stringValue("d"), Kept: true},
	}}}}
	if got := valueOf(expr); !proto.Equal(got, want) {
		t.Errorf("valueOf = %s\nwant %s", prototext.Format(got), prototext.Format(want))
	}
}

func TestValueOfMarksUnrepresentableExpressionsOpaque(t *testing.T) {
	for _, source := range []string{
		`helper(1)`,
		`a if b else c`,
		`1.5`,
		`CONSTANT`,
		`glob(["*"], exclude_directories = 0)`,
		`glob([name])`,
		`select({CONDITION: []})`,
		`select({"//c:x": []}, no_match_error = "unsupported")`,
		`["a"] * 2`,
	} {
		value := valueOf(parseExpr(t, source))
		if got := value.GetOpaque().GetSource(); got != bzl.FormatString(parseExpr(t, source)) {
			t.Errorf("valueOf(%s) = %s, want opaque", source, prototext.Format(value))
		}
	}
}

func TestRuleOfReportsRuleAndAttributeKeeps(t *testing.T) {
	f, err := rule.LoadData("BUILD.bazel", "pkg", []byte(`
fake_library(
    name = "lib",
    srcs = ["a.rs"],  # keep
    version = "1",
)

# keep
fake_test(name = "test")
`))
	if err != nil {
		t.Fatal(err)
	}
	got := buildFileOf(f)
	want := &gazellev1.BuildFile{Name: "BUILD.bazel", Rules: []*gazellev1.Rule{
		{Kind: "fake_library", Name: "lib", Attributes: map[string]*gazellev1.Attribute{
			"srcs":    {Value: valueOf(parseExpr(t, `["a.rs"]`)), Kept: true},
			"version": {Value: stringValue("1")},
		}},
		{Kind: "fake_test", Name: "test", Attributes: map[string]*gazellev1.Attribute{}, Kept: true},
	}}
	if !proto.Equal(got, want) {
		t.Errorf("buildFileOf = %s\nwant %s", prototext.Format(got), prototext.Format(want))
	}
}

func TestIsEmptyOmitsOnlyValuesWithoutContent(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value *gazellev1.Value
		empty bool
	}{
		{"empty list", list(), true},
		{"empty dict", dict(), true},
		{"select with empty branches", selection(when("//c:x", list()), when("//conditions:default", list())), true},
		{"concatenation of empties", &gazellev1.Value{Value: &gazellev1.Value_Concatenation{Concatenation: &gazellev1.Concatenation{Operands: []*gazellev1.Value{list(), selection()}}}}, true},
		{"list", listOf("a"), false},
		{"select with one branch", selection(when("//c:x", listOf("a")), when("//conditions:default", list())), false},
		{"empty string", stringValue(""), false},
		{"glob", glob("*"), false},
		{"reference", reference("pkg:a", ""), false},
	} {
		if got := isEmpty(tc.value); got != tc.empty {
			t.Errorf("isEmpty(%s) = %v", tc.name, got)
		}
	}
}

func TestCheckValueRejectsInvalidGeneratedValues(t *testing.T) {
	for _, tc := range []struct {
		name       string
		value      *gazellev1.Value
		references bool
		want       string
	}{
		{"unset", &gazellev1.Value{}, true, "unset"},
		{"reference outside a resolve attribute", list(reference("pkg:a", "")), false, "resolve attributes"},
		{"reference key outside a resolve attribute", dict(entry(reference("pkg:a", ""), stringValue("b"))), false, "resolve attributes"},
		{"reference without import", reference("", "//a"), true, "no import"},
		{"opaque", &gazellev1.Value{Value: &gazellev1.Value_Opaque{Opaque: &gazellev1.Opaque{Source: "f()"}}}, true, "existing rules"},
		{"select case without condition", selection(when("", listOf("a"))), true, "no condition"},
		{"one-operand concatenation", &gazellev1.Value{Value: &gazellev1.Value_Concatenation{Concatenation: &gazellev1.Concatenation{Operands: []*gazellev1.Value{listOf("a")}}}}, true, "fewer than two"},
	} {
		err := checkValue(tc.value, tc.references)
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("checkValue(%s) = %v, want an error containing %q", tc.name, err, tc.want)
		}
	}
	if err := checkValue(dict(entry(reference("pkg:a", ""), list(reference("pkg:b", "//b")))), true); err != nil {
		t.Errorf("checkValue(references in a resolve attribute) = %v", err)
	}
}
