import { expect, test, type Locator, type Page } from '@playwright/test';

async function dragText(page: Page, content: Locator, start: number, end: number) {
  await page.evaluate(() => document.fonts.ready);
  await content.click({ trial: true });
  const points = await content.evaluate((element, offsets) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    const point = (offset: number) => {
      for (const node of nodes) {
        if (offset < node.length) {
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + 1);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + 0.5, y: rect.top + rect.height / 2 };
        }
        offset -= node.length;
      }
      throw new Error('Selection offset outside text');
    };
    return { start: point(offsets.start), end: point(offsets.end), expected: element.textContent!.slice(offsets.start, offsets.end) };
  }, { start, end });
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 24 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(points.expected);
}


type Probe = { x: number; y: number; label: string };

/**
 * What the selection painted over a surface: the pixels that differ between a
 * capture with the selection and one without, with every glyph hidden in both.
 */
async function selectionPaint(page: Page, surface: Locator) {
  await page.addStyleTag({ content: `
    [data-selection-sample] *, [data-selection-sample] *::selection, [data-selection-sample] *::marker {
      color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important;
    }` });
  await page.evaluate(() => document.fonts.ready);
  const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.move(2, 2);
  await settle();
  const plain = await surface.screenshot();

  const geometry = await surface.evaluate(element => {
    const origin = element.getBoundingClientRect();
    const linesOf = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const lines: { left: number; right: number; top: number; bottom: number }[] = [];
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width < 1 || rect.height < 1) continue;
        const line = lines.find(candidate => Math.abs((candidate.top + candidate.bottom) / 2 - (rect.top + rect.bottom) / 2) < 4);
        if (!line) lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
        else Object.assign(line, {
          left: Math.min(line.left, rect.left), right: Math.max(line.right, rect.right),
          top: Math.min(line.top, rect.top), bottom: Math.max(line.bottom, rect.bottom),
        });
      }
      return lines;
    };
    const probes: Probe[] = [];
    const name = (node: Element) => node.textContent!.trim().slice(0, 18);
    const at = (x: number, y: number, label: string) => probes.push({ x: x - origin.left, y: y - origin.top, label });
    // Past the end of each line: paragraphs, headings, quotes, list items, table cells and code.
    for (const node of Array.from(element.querySelectorAll('p, [data-markdown-heading], li, th, td, pre code > div'))) {
      const box = node.matches('th, td') ? node : node.closest('pre');
      const limit = (box ? box.getBoundingClientRect() : origin).right - 2;
      linesOf(node).forEach((line, index) => {
        if (line.right + 14 < limit) at(line.right + 14, (line.top + line.bottom) / 2, `after line ${index + 1} of "${name(node)}"`);
      });
    }
    // Beside a code block, inside its frame.
    for (const code of Array.from(element.querySelectorAll('pre'))) {
      const [box, frame] = [code.getBoundingClientRect(), code.parentElement!.getBoundingClientRect()];
      if (frame.right - box.right >= 16) at(box.right + 8, (box.top + box.bottom) / 2, 'beside the code block');
    }
    // The list marker in front of each item.
    for (const item of Array.from(element.querySelectorAll('li'))) {
      const [first] = linesOf(item);
      if (first) at(first.left - 13, (first.top + first.bottom) / 2, `marker of "${name(item)}"`);
    }
    // The empty space between two blocks.
    const blocks = Array.from(element.children).map(child => child.getBoundingClientRect());
    blocks.slice(1).forEach((block, index) => {
      const previous = blocks[index];
      if (block.top - previous.bottom >= 6) at(origin.left + 40, (previous.bottom + block.top) / 2, `gap above block ${index + 2}`);
    });
    // One background, so one selection tone: every block except the table.
    const even = Array.from(element.children).filter(child => !child.querySelector('table, pre') && !child.matches('pre')).map(child => {
      const rect = child.getBoundingClientRect();
      return { left: rect.left - origin.left, right: rect.right - origin.left, top: rect.top - origin.top, bottom: rect.bottom - origin.top };
    });
    const texts: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const edge = (text: Text, offset: number, end: boolean) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const rect = range.getBoundingClientRect();
      return { x: end ? rect.right - 0.5 : rect.left + 0.5, y: rect.top + rect.height / 2 };
    };
    const last = texts[texts.length - 1];
    return { probes, even, width: origin.width, start: edge(texts[0], 0, false), end: edge(last, last.length - 1, true), expected: last.data };
  });

  await page.mouse.move(geometry.start.x, geometry.start.y);
  await page.mouse.down();
  await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 24 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain(geometry.expected);
  await settle();
  const selected = await surface.screenshot();

  return page.evaluate(async ({ plain, selected, probes, even, width }) => {
    const pixels = async (encoded: string) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, canvas.width, canvas.height);
    };
    const [before, after] = [await pixels(plain), await pixels(selected)];
    // Captures are in device pixels; the geometry is in CSS pixels.
    const scale = before.width / width;
    const painted = (x: number, y: number) => {
      const index = (y * before.width + x) * 4;
      return [0, 1, 2].some(channel => Math.abs(before.data[index + channel] - after.data[index + channel]) > 2);
    };
    const paintedAt = (probe: Probe) => {
      const [x, y] = [Math.round(probe.x * scale), Math.round(probe.y * scale)];
      return x >= 0 && y >= 0 && x < before.width && y < before.height && painted(x, y);
    };
    const tones = new Map<string, number>();
    let paintedPixels = 0;
    for (let y = 0; y < before.height; y += 1) {
      for (let x = 0; x < before.width; x += 1) {
        if (!painted(x, y)) continue;
        paintedPixels += 1;
        if (!even.some(rect => x >= rect.left * scale && x < rect.right * scale && y >= rect.top * scale && y < rect.bottom * scale)) continue;
        const index = (y * before.width + x) * 4;
        const tone = Array.from(after.data.slice(index, index + 3)).join(' ');
        tones.set(tone, (tones.get(tone) ?? 0) + 1);
      }
    }
    return {
      paintedPixels,
      probeCount: probes.length,
      paintedProbes: probes.filter(paintedAt).map(probe => probe.label),
      tones: Array.from(tones.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, { plain: plain.toString('base64'), selected: selected.toString('base64'), probes: geometry.probes, even: geometry.even, width: geometry.width });
}

test.describe('selection inside a message', () => {
test.beforeEach(async ({ page }) => {
  await page.goto('/tests/visual/textSelectionPreview.html');
  await expect(page.getByRole('heading', { name: 'Text selection review' })).toBeVisible();
});

test('partial words and wrapped ranges retain exact visible selection endpoints', async ({ page }) => {
  const surface = page.locator('[data-kordi-copy-surface="message"]').first();
  const firstParagraph = surface.locator('p').first();
  await dragText(page, firstParagraph, 3, 6);
  const paragraph = surface.locator('p').nth(1);
  await dragText(page, paragraph, 12, 195);
  await expect.poll(() => page.evaluate(() => {
    const selection = window.getSelection()!;
    return new Set(Array.from(selection.getRangeAt(0).getClientRects()).map(rect => Math.round(rect.top))).size;
  })).toBeGreaterThan(1);
  await expect(surface).not.toHaveAttribute('data-kordi-copy-selection', 'unified');
  expect(await surface.evaluate(element => getComputedStyle(element, '::before').content)).toBe('none');
  expect(await firstParagraph.evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});

test('double click selects a word', async ({ page }) => {
  const paragraph = page.locator('[data-kordi-copy-surface="message"]').first().locator('p').first();
  await paragraph.scrollIntoViewIfNeeded();
  await paragraph.dblclick({ position: { x: 15, y: 10 } });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString().trim())).toBe('Welcome');
});

test('keyboard copy preserves a partial range', async ({ page }) => {
  const paragraph = page.locator('[data-kordi-copy-surface="message"]').first().locator('p').first();
  await dragText(page, paragraph, 3, 6);
  // Exercise the browser copy command, then paste into the review field.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.getByLabel('Paste here to check the exact text you copied').click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v');
  await expect(page.getByLabel('Paste here to check the exact text you copied')).toHaveValue('com');
});

test('dark appearance retains precise selection in formatted text', async ({ page }) => {
  await page.getByRole('button', { name: 'Dark appearance' }).click();
  const surface = page.locator('[data-kordi-copy-surface="message"]').last();
  const paragraph = surface.locator('p').first();
  await paragraph.scrollIntoViewIfNeeded();
  await dragText(page, paragraph, 4, 34);
  await expect(surface).not.toHaveAttribute('data-kordi-copy-selection', 'unified');
});
});

for (const appearance of ['light', 'dark'] as const) {
  test(`a selection across blocks tints only the text behind it (${appearance})`, async ({ page }) => {
    await page.goto('/tests/visual/textSelectionBlocks.html');
    await expect(page.getByRole('heading', { name: 'Text selection across blocks' })).toBeVisible();
    if (appearance === 'dark') await page.getByRole('button', { name: 'Dark appearance' }).click();
    await page.getByRole('button', { name: /^Show \d+ more lines?$/ }).click();
    const surface = page.locator('[data-selection-sample="reply"] [data-kordi-copy-surface="message"]').first();

    const paint = await selectionPaint(page, surface);

    expect(paint.paintedPixels).toBeGreaterThan(1000);
    expect(paint.probeCount).toBeGreaterThan(20);
    // Nothing past the end of a line, on a list marker, or in the space between blocks.
    expect(paint.paintedProbes).toEqual([]);
    // One even tone: overlapping fills would show up as a second, darker one.
    expect(paint.tones.map(([tone]) => tone)).toHaveLength(1);
  });
}
