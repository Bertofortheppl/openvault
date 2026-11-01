import { MarkdownRenderer, type App, type Component } from 'obsidian';

export function renderMarkdown(
  app: App,
  el: HTMLElement,
  text: string,
  sourcePath: string,
  component: Component,
): void {
  el.empty();
  void MarkdownRenderer.render(app, text, el, sourcePath, component);
}

export function isNearBottom(el: HTMLElement, threshold = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

export function scrollToBottom(el: HTMLElement): void {
  el.scrollTop = el.scrollHeight;
}
