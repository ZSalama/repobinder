import { KeyboardEvent, RefObject, useEffect, useRef } from "react";

const focusableSelector = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalFocus<T extends HTMLElement>(
  onClose: () => void,
  options: { closeOnEscape?: boolean } = {},
): { containerRef: RefObject<T>; onKeyDown: (event: KeyboardEvent<T>) => void } {
  const containerRef = useRef<T>(null);
  const closeOnEscape = options.closeOnEscape ?? true;

  useEffect(() => {
    const container = containerRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;

    if (!container) {
      return undefined;
    }

    window.requestAnimationFrame(() => {
      const [firstFocusable] = getFocusableElements(container);
      (firstFocusable ?? container).focus();
    });

    return () => {
      if (previousFocus && document.contains(previousFocus)) {
        previousFocus.focus();
      }
    };
  }, []);

  function onKeyDown(event: KeyboardEvent<T>): void {
    if (event.key === "Escape" && closeOnEscape) {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    const container = containerRef.current;

    if (!container) {
      return;
    }

    const focusableElements = getFocusableElements(container);
    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (!firstFocusable || !lastFocusable) {
      event.preventDefault();
      container.focus();
      return;
    }

    const activeElement = document.activeElement;

    if (event.shiftKey && (activeElement === firstFocusable || !container.contains(activeElement))) {
      event.preventDefault();
      lastFocusable.focus();
      return;
    }

    if (!event.shiftKey && activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }

  return { containerRef, onKeyDown };
}

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) =>
      !element.hasAttribute("disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.tabIndex !== -1 &&
      element.offsetParent !== null,
  );
}
