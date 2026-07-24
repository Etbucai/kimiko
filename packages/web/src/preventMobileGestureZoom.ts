const preventDefault = (event: Event): void => {
  event.preventDefault();
};

const preventMultiTouchMove = (event: TouchEvent): void => {
  if (event.touches.length > 1) {
    event.preventDefault();
  }
};

export const preventMobileGestureZoom = (): void => {
  document.addEventListener("gesturestart", preventDefault, { passive: false });
  document.addEventListener("gesturechange", preventDefault, {
    passive: false,
  });
  document.addEventListener("gestureend", preventDefault, { passive: false });
  document.addEventListener("touchmove", preventMultiTouchMove, {
    passive: false,
  });
};
