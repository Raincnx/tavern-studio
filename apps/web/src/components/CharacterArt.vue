<script setup lang="ts">
import type { Character } from '@tavern/contracts';
defineProps<{ character: Character; small?: boolean }>();
</script>

<template>
  <div class="character-art" :class="[character.color, { small }]">
    <img v-if="character.avatarId" :src="`/api/v1/media/${character.avatarId}`" :alt="character.name" />
    <template v-else>
      <div class="art-halo"></div><div class="art-orbit orbit-one"></div><div class="art-orbit orbit-two"></div>
      <svg class="art-plant" viewBox="0 0 200 240" fill="none" aria-hidden="true">
        <path d="M101 230C100 166 111 101 137 28M104 182C69 180 38 152 29 121c37 0 63 21 75 61ZM111 141c35-4 61-27 68-56-31 3-57 21-68 56ZM120 98c-25-7-44-28-46-56 29 10 43 25 46 56ZM134 49c20-5 31-19 34-36-21 6-31 20-34 36Z" stroke="currentColor" stroke-width="1.2" />
        <path d="M102 205C66 202 44 182 39 166c28 3 48 16 63 39ZM104 163c34-3 60-17 68-34-30 0-54 12-68 34Z" fill="currentColor" fill-opacity=".12" stroke="currentColor" stroke-width=".7" />
      </svg>
      <span class="art-coordinate">{{ character.color === 'sage' ? '35° N · FOREST NOTES' : character.color === 'amber' ? '23:48 · THE NIGHT LIBRARY' : 'SECTOR 07 · STELLAR ARCHIVE' }}</span>
      <span class="art-monogram">{{ character.name.slice(0, 1) }}</span>
    </template>
  </div>
</template>
