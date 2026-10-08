<script lang="ts">
  import { value } from "@fixture/lib";

  import Widget from "#lib/widget.svelte";
</script>

<Widget label={String(value)} />
