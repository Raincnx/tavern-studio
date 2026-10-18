<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string[]> = {
  chat: ['M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-2 2V11.5A8.5 8.5 0 0 1 10.5 3h2a8.5 8.5 0 0 1 8.5 8.5Z', 'M7 10h10M7 14h6'],
  people: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM17 3.13a4 4 0 0 1 0 7.75'],
  image: ['M4 3h16a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z', 'm3 16 5-5 5 5 4-4 4 4M8 7h.01'],
  sliders: ['M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 10h6M9 8h6m2 8h6'],
  queue: ['M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01'],
  plus: ['M12 5v14M5 12h14'],
  arrow: ['M7 17 17 7M7 7h10v10'],
  send: ['m5 12 7-7 7 7M12 5v15'],
  search: ['M21 21l-5-5', 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z'],
  spark: ['m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3ZM20 2v4m-2-2h4'],
  close: ['m6 6 12 12M6 18 18 6'],
  download: ['M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4'],
  upload: ['M12 16V4m-5 5 5-5 5 5M4 16v4h16v-4'],
  edit: ['m16 3 5 5-12 12-6 1 1-6L16 3ZM13 6l5 5'],
  check: ['m5 12 4 4L19 6'],
  stop: ['M6 6h12v12H6Z'],
  copy: ['M9 9h12v12H9ZM5 15H3V3h12v2'],
  refresh: ['M21 3v6h-6M3 21v-6h6', 'M20 9A8 8 0 0 0 6 5L3 9m18 6-3 4A8 8 0 0 1 4 15'],
  chevron: ['m9 5 7 7-7 7'],
  leaf: ['M20 3c0 11-2 16-9 16a7 7 0 0 1-7-7c0-7 7-9 16-9Z', 'M3 21 15 9'],
  book: ['M12 5C9 3 5 3 2 4v16c4-1 7-1 10 1 3-2 6-2 10-1V4c-3-1-7-1-10 1Zm0 0v16'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  info: ['M12 8h.01M12 11v6', 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z'],
  clock: ['M12 7v5l3 2', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z'],
};
</script>

<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path v-for="(path, index) in paths[name] ?? paths.spark" :key="index" :d="path" /></svg>
</template>
