export const PASTEL_COLORS = [
  "#FFAB91", "#FFD54F", "#FFF59D", "#DCE775", "#AED581", "#81C784",
  "#4DB6AC", "#4DD0E1", "#4FC3F7", "#64B5F6", "#7986CB", "#9575CD",
  "#BA68C8", "#F06292", "#E0E0E0", "#BCAAA4"
];

export const HABITATS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// 150 items
export const ACCESSORIES = [
  "/models/assets/Clipboard.png",
  "/models/assets/ExecutivePlant.png",
  ...Array.from({ length: 6 }, (_, s) =>
    Array.from({ length: 25 }, (_, i) =>
      `/accessories/accessories_set_${s + 1}_item_${String(i + 1).padStart(2, '0')}.png`
    )
  ).flat()
];
