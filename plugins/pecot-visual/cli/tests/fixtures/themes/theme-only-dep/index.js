import { computed, ref } from 'vue'

// テーマだけが使う依存の見本。置き場の中から vue を引く流れを試すために、vue を import する
export function decorate(text) {
  const source = ref(text)
  return computed(() => `[${source.value}]`).value
}
