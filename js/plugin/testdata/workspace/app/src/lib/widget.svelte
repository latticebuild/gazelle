<script lang="ts">
  import { PUBLIC_NAME } from "$env/static/public";

  let { label }: { label: string } = $props();
</script>

<p>{PUBLIC_NAME}: {label}</p>
