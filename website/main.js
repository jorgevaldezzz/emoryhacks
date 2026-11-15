const root = document.documentElement;

const setPointerGlow = (event) => {
  root.style.setProperty("--mx", `${event.clientX}px`);
  root.style.setProperty("--my", `${event.clientY}px`);
};

window.addEventListener("pointermove", setPointerGlow, { passive: true });

document.querySelectorAll(".cta").forEach((button) => {
  button.addEventListener("pointerenter", () => {
    button.style.setProperty("--press", "1");
  });
  button.addEventListener("pointerleave", () => {
    button.style.setProperty("--press", "0");
  });
});
