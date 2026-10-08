<!-- Generated with Stardoc: http://skydoc.bazel.build -->

Compose a Gazelle executable with the prepared JavaScript plugin.

<a id="gazelle_binary"></a>

## gazelle_binary

<pre>
load("@latticebuild_gazelle//gazelle:defs.bzl", "gazelle_binary")

gazelle_binary(<a href="#gazelle_binary-name">name</a>, <a href="#gazelle_binary-plugin">plugin</a>, <a href="#gazelle_binary-index">index</a>, <a href="#gazelle_binary-loads">loads</a>, <a href="#gazelle_binary-kwargs">**kwargs</a>)
</pre>

Build the host with caller-owned declared plugin inputs.

**PARAMETERS**


| Name  | Description | Default Value |
| :------------- | :------------- | :------------- |
| <a id="gazelle_binary-name"></a>name |  Executable target name.   |  none |
| <a id="gazelle_binary-plugin"></a>plugin |  Prepared executable JavaScript plugin.   |  none |
| <a id="gazelle_binary-index"></a>index |  Version-3 pnpm workspace index.   |  none |
| <a id="gazelle_binary-loads"></a>loads |  JSON array of {kind, label} records for the selected rule owners.   |  none |
| <a id="gazelle_binary-kwargs"></a>kwargs |  Standard go_binary attributes.   |  none |
