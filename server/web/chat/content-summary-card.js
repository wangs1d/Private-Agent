export function parseContentSummaryV2(text: string): {
  summary: ContentSummaryDataV2 | null;
  briefText: string;
  cleanedText: string;
} {
  const startMarker = "[CONTENT_SUMMARY_V2_START]";
  const endMarker = "[CONTENT_SUMMARY_V2_END]";
  const cardMarker = /<details_card\s+ref="([^"]+)"\s*\/>/;

  const startIndex = text.indexOf(startMarker);
  const endIndex = text.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1) {
    return { summary: null, briefText: "", cleanedText: text };
  }

  try {
    const jsonStr = text.slice(
      startIndex + startMarker.length,
      endIndex
    ).trim();

    const data = JSON.parse(jsonStr);
    
    const afterEnd = text.slice(endIndex + endMarker.length).trim();
    
    const cardMatch = afterEnd.match(cardMarker);
    
    let briefText = "";
    let displayText = afterEnd;

    if (cardMatch) {
      briefText = afterEnd.slice(0, cardMatch.index).trim();
      displayText = briefText;
    }

    if (!briefText.trim() && data.detailContent?.trim()) {
      briefText = buildOverviewBrief(data);
    } else if (briefText.trim().length < 24 && data.detailContent?.trim()) {
      const overview = buildOverviewBrief(data);
      if (overview.length > briefText.trim().length) {
        briefText = overview;
      }
    }

    return {
      summary: data as ContentSummaryDataV2,
      briefText,
      cleanedText: displayText,
    };
  } catch (e) {
    console.warn("[content-summary-card] Failed to parse:", e);
    return { summary: null, briefText: "", cleanedText: text };
  }
}

export interface SectionInfoData {
  title: string;
  pointCount: number;
}

export interface ContentSummaryDataV2 {
  type: string;
  id: string;
  category: string;
  title: string;
  cardIcon: string;
  cardLabel: string;
  briefCount: number;
  detailContent?: string;
  sections?: SectionInfoData[];
  metadata?: Record<string, unknown>;
}

const storedDetails = new Map<string, string>();
const storedSections = new Map<string, SectionInfoData[]>();

export function storeDetailContent(id: string, content: string): void {
  storedDetails.set(id, content);
}

export function storeSections(id: string, sections: SectionInfoData[]): void {
  storedSections.set(id, sections);
}

export function getDetailContent(id: string): string | undefined {
  return storedDetails.get(id);
}

export function getSections(id: string): SectionInfoData[] | undefined {
  return storedSections.get(id);
}

const CATEGORY_LABELS: Record<string, string> = {
  news: "新闻资讯",
  article: "文章阅读",
  search_result: "检索结果",
  webpage: "网页摘录",
  document: "文档资料",
  data: "调研报告",
  list: "任务清单",
  multi_section: "专题汇总",
  table: "数据表格",
  general: "内容详情",
};

const LEGACY_GENERIC_LABELS = new Set([
  "详情", "资讯", "文章", "网页", "文档", "代码", "清单", "汇总", "数据表",
]);

function resolveTaskSubject(data: ContentSummaryDataV2): string {
  const fromMeta = data.metadata?.subjectLabel;
  if (typeof fromMeta === "string" && fromMeta.trim()) {
    return fromMeta.trim();
  }
  const fromCard = (data.cardLabel ?? "").trim();
  if (fromCard && !LEGACY_GENERIC_LABELS.has(fromCard)) {
    return fromCard;
  }
  return CATEGORY_LABELS[data.category] ?? "内容详情";
}

function buildOverviewBrief(data: ContentSummaryDataV2): string {
  const subject = resolveTaskSubject(data);
  const wordCount =
    (data.metadata && typeof data.metadata.wordCount === "number"
      ? data.metadata.wordCount
      : data.detailContent?.length) ?? 0;
  const title = (data.title ?? "").trim();
  const hasHeadline =
    title.length > 2 && !title.includes("_") && title !== subject;
  const headlineHint = hasHeadline
    ? `（${title.length > 36 ? title.slice(0, 33) + "..." : title}）`
    : "";
  const parts: string[] = [
    `【${subject}】全文约 ${wordCount} 字${headlineHint}。以下为概要，完整内容见下方详情卡。`,
  ];

  if (data.sections && data.sections.length > 1) {
    const titles = data.sections
      .map((s) => s.title.trim())
      .filter(Boolean);
    if (titles.length <= 4) {
      parts.push(`主要涵盖：${titles.join("、")}。`);
    } else {
      parts.push(
        `主要涵盖 ${titles.length} 个部分：${titles.slice(0, 3).join("、")}等。`,
      );
    }
  }

  return parts.join("\n");
}

export function renderContentSummaryCardV2(
  data: ContentSummaryDataV2, 
  briefText?: string, 
  detailContent?: string
): string {
  if (detailContent) {
    storeDetailContent(data.id, detailContent);
  }
  
  if (data.sections) {
    storeSections(data.id, data.sections);
  }

  const displayLabel = resolveTaskSubject(data);

  let html = `<div class="content-summary-v2" data-category="${data.category}">`;

  if (briefText && briefText.trim()) {
    html += `<div class="brief-points">${escapeHtml(briefText).replace(/\n/g, '<br/>')}</div>`;
  }

  html += `
    <div class="detail-card ${data.category}" data-card-id="${data.id}" onclick="openDetailModal('${data.id}')">
      <div class="detail-card-left">
        <span class="detail-card-icon">${escapeHtml(data.cardIcon)}</span>
      </div>
      <div class="detail-card-center">
        <div class="detail-card-title">${escapeHtml(data.title)}</div>
        <div class="detail-card-subtitle">${displayLabel}${data.sections ? ` · ${data.sections.length}个板块` : ''}</div>
      </div>
      <div class="detail-card-right">
        <svg class="detail-chevron" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    </div>
  `;

  html += `</div>`;

  return html;
}

function renderModalBody(data: ContentSummaryDataV2): string {
  const content = getDetailContent(data.id) ?? '暂无详细内容';
  const sections = getSections(data.id);
  const displayLabel = resolveTaskSubject(data);
  const subtitle = sections && sections.length > 1
    ? `${displayLabel} · ${sections.length}个板块`
    : displayLabel;

  let bookmarkRailHtml = '';
  if (sections && sections.length > 1) {
    bookmarkRailHtml = `
      <aside class="detail-modal-bookmark-rail-wrap">
        <button type="button" class="bookmark-scroll-hint bookmark-scroll-up" aria-label="向上滚动" onclick="scrollBookmarkRail(-120)">▴</button>
        <nav class="detail-modal-bookmark-rail" aria-label="内容目录">
          ${sections.map((s, i) => `
            <button type="button" class="bookmark-item${i === 0 ? ' active' : ''}" onclick="event.stopPropagation(); scrollToSection('${data.id}', ${i})">
              <span class="bookmark-item-title">${escapeHtml(s.title)}</span>
              <span class="bookmark-item-count">${s.pointCount} 条</span>
            </button>
          `).join('')}
        </nav>
        <button type="button" class="bookmark-scroll-hint bookmark-scroll-down" aria-label="向下滚动" onclick="scrollBookmarkRail(120)">▾</button>
      </aside>
    `;
  }

  return `
    <div class="detail-modal-header" data-modal-drag-handle="true">
      <span class="detail-modal-drag-handle" aria-hidden="true">⋮⋮</span>
      <div class="detail-modal-header-icon">${escapeHtml(data.cardIcon)}</div>
      <div class="detail-modal-header-text">
        <div class="detail-modal-title" id="detail-modal-title">${escapeHtml(data.title)}</div>
        <div class="detail-modal-subtitle">${escapeHtml(subtitle)}</div>
      </div>
      <button type="button" class="detail-modal-close" onclick="closeDetailModal()" aria-label="关闭">×</button>
    </div>
    <div class="detail-modal-main${sections && sections.length > 1 ? ' has-bookmarks' : ''}">
      ${bookmarkRailHtml}
      <div class="detail-modal-body" id="detail-modal-scroll-${data.id}">
        <div class="detail-text">${formatDetailContent(content, data.id, sections)}</div>
        ${renderMetadata(data.metadata)}
      </div>
    </div>
  `;
}

function ensureDetailModalShell(): HTMLElement {
  let overlay = document.getElementById('content-summary-modal-overlay');
  if (overlay) return overlay;

  overlay = document.createElement('div');
  overlay.id = 'content-summary-modal-overlay';
  overlay.className = 'content-summary-modal-overlay';
  overlay.innerHTML = `
    <div class="content-summary-modal-backdrop" onclick="closeDetailModal()"></div>
    <div class="content-summary-modal-panel" role="dialog" aria-modal="true" aria-labelledby="detail-modal-title"></div>
  `;
  document.body.appendChild(overlay);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeDetailModal();
    }
  });

  return overlay;
}

function parseMarkdownTableCells(line: string): string[] {
  let inner = line.trim();
  if (inner.startsWith('|')) inner = inner.slice(1);
  if (inner.endsWith('|')) inner = inner.slice(0, -1);
  return inner.split('|').map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string): boolean {
  return parseMarkdownTableCells(line).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  return /^\|?(?:\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?$/.test(trimmed);
}

function parseMarkdownTableCell(raw: string) {
  const trimmed = raw.trim();
  if (trimmed === '^' || trimmed === '^^') {
    return { text: '', colspan: 1, rowspan: 1, skip: true };
  }

  let colspan = 1;
  let rowspan = 1;
  let text = trimmed;
  const spanMatch = text.match(/^\{(?:colspan|c)=(\d+)\}(?:\{(?:rowspan|r)=(\d+)\})?\s*/);
  const rowOnly = text.match(/^\{(?:rowspan|r)=(\d+)\}\s*/);

  if (spanMatch) {
    colspan = Number(spanMatch[1]);
    if (spanMatch[2]) rowspan = Number(spanMatch[2]);
    text = text.slice(spanMatch[0].length);
  } else if (rowOnly) {
    rowspan = Number(rowOnly[1]);
    text = text.slice(rowOnly[0].length);
  }

  return { text, colspan, rowspan, skip: false };
}

function formatInlineMarkdown(text: string): string {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return html;
}

function renderMarkdownTable(lines: string[]): string {
  const parsedRows = lines
    .map((line) => parseMarkdownTableCells(line.trim()).map(parseMarkdownTableCell))
    .filter((cells) => cells.length > 0);

  if (parsedRows.length === 0) return '';

  let headerCells = null;
  let bodyRows = parsedRows;

  if (parsedRows.length >= 2 && isMarkdownTableSeparator(lines[1])) {
    headerCells = parsedRows[0];
    bodyRows = parsedRows.slice(2);
  }

  const allRows = headerCells ? [headerCells, ...bodyRows] : bodyRows;
  const columnCount = allRows.reduce((max, row) => {
    const count = row.reduce((sum, cell) => sum + (cell.skip ? 0 : cell.colspan), 0);
    return count > max ? count : max;
  }, 0);

  const occupied = Array.from({ length: allRows.length + 4 }, () => Array(columnCount + 4).fill(false));
  const htmlRows: string[] = [];

  allRows.forEach((row, rowIndex) => {
    const isHeader = headerCells != null && rowIndex === 0;
    const cells: string[] = [];
    let colIndex = 0;

    for (const cell of row) {
      while (colIndex < columnCount && occupied[rowIndex][colIndex]) colIndex++;
      if (colIndex >= columnCount) break;
      if (cell.skip) continue;

      for (let r = 0; r < cell.rowspan; r++) {
        for (let c = 0; c < cell.colspan; c++) {
          occupied[rowIndex + r][colIndex + c] = true;
        }
      }

      const tag = isHeader ? 'th' : 'td';
      const attrs = [
        cell.colspan > 1 ? ` colspan="${cell.colspan}"` : '',
        cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : '',
      ].join('');
      cells.push(`<${tag}${attrs}>${formatInlineMarkdown(cell.text)}</${tag}>`);
      colIndex += cell.colspan;
    }

    htmlRows.push(`<tr>${cells.join('')}</tr>`);
  });

  const headHtml = headerCells ? `<thead>${htmlRows.shift()}</thead>` : '';
  return `<div class="content-table-wrap"><table class="content-table">${headHtml}<tbody>${htmlRows.join('')}</tbody></table></div>`;
}

function matchSectionId(title: string, sections?: SectionInfoData[], cardId?: string): string {
  if (!sections || !cardId) return '';
  for (let i = 0; i < sections.length; i++) {
    const sectionTitle = sections[i].title.trim();
    if (title.includes(sectionTitle) || sectionTitle.includes(title)) {
      return ` id="detail-section-${cardId}-${i}"`;
    }
  }
  return '';
}

function formatDetailContent(content: string, cardId?: string, sections?: SectionInfoData[]): string {
  const lines = content.split('\n');
  const parts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const trimmed = lines[index].trim();

    if (!trimmed) {
      index++;
      continue;
    }

    if (trimmed.startsWith('```')) {
      const start = index;
      index++;
      while (index < lines.length && !lines[index].trim().startsWith('```')) index++;
      if (index < lines.length) index++;
      const code = lines.slice(start + 1, index - 1).join('\n');
      parts.push(`<pre class="content-code-block"><code>${escapeHtml(code)}</code></pre>`);
      continue;
    }

    if (trimmed.startsWith('>')) {
      const start = index;
      while (index < lines.length && lines[index].trim().startsWith('>')) index++;
      const quote = lines.slice(start, index)
        .map((line) => line.trim().replace(/^>\s?/, ''))
        .join('\n');
      parts.push(`<blockquote class="content-blockquote">${formatInlineMarkdown(quote).replace(/\n/g, '<br/>')}</blockquote>`);
      continue;
    }

    if (/^(一|二|三|四|五|六|七|八|九|十)[、.．]/.test(trimmed)) {
      parts.push(`<div class="content-section-header"${matchSectionId(trimmed, sections, cardId)}>${formatInlineMarkdown(trimmed)}</div>`);
      index++;
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const title = trimmed.replace(/^#+\s*/, '');
      parts.push(`<div class="content-section-header"${matchSectionId(title, sections, cardId)}>${formatInlineMarkdown(title)}</div>`);
      index++;
      continue;
    }

    if (/^[\s]*[-•*→▸‣⁃◦·]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[\s]*[-•*→▸‣⁃◦·]\s*/, '');
      parts.push(`<div class="content-list-item">${formatInlineMarkdown(item)}</div>`);
      index++;
      continue;
    }

    if (/^[\s]*\d+[.)]\s+/.test(trimmed)) {
      const item = trimmed.replace(/^[\s]*\d+[.)]\s+/, '');
      const marker = trimmed.slice(0, trimmed.indexOf(item)).trim();
      parts.push(`<div class="content-ordered-item"><span class="content-ordered-marker">${escapeHtml(marker)}</span><span>${formatInlineMarkdown(item)}</span></div>`);
      index++;
      continue;
    }

    if (isMarkdownTableRow(trimmed)) {
      const start = index;
      while (index < lines.length && isMarkdownTableRow(lines[index].trim())) index++;
      parts.push(renderMarkdownTable(lines.slice(start, index)));
      continue;
    }

    if (trimmed.length > 100) {
      parts.push(`<div class="content-paragraph">${formatInlineMarkdown(trimmed)}</div>`);
    } else {
      parts.push(`<div class="content-line">${formatInlineMarkdown(trimmed)}</div>`);
    }
    index++;
  }

  return parts.join('');
}

function renderMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) return '';

  const tags = [];
  
  if (metadata.wordCount) tags.push({ label: '字数', value: metadata.wordCount });
  if (metadata.sectionCount && Number(metadata.sectionCount) > 1) tags.push({ label: '板块', value: `${metadata.sectionCount}个` });
  if (metadata.source) tags.push({ label: '来源', value: metadata.source });

  if (tags.length === 0) return '';

  return `<div class="detail-meta">
    ${tags.map(t => `<span class="meta-tag"><span class="meta-label">${t.label}</span>${t.value}</span>`).join('')}
  </div>`;
}

const modalDragState = {
  active: false,
  startX: 0,
  startY: 0,
  offsetX: 0,
  offsetY: 0,
};

window.openDetailModal = function(id: string) {
  const summaryData = window.__contentSummaries?.[id];
  if (!summaryData) return;

  const overlay = ensureDetailModalShell();
  const panel = overlay.querySelector('.content-summary-modal-panel') as HTMLElement | null;
  if (!panel) return;

  modalDragState.offsetX = 0;
  modalDragState.offsetY = 0;
  panel.style.transform = '';

  panel.innerHTML = renderModalBody(summaryData);
  overlay.classList.add('open');
  document.body.classList.add('detail-modal-open');
  bindBookmarkRailScrollHints();
  bindModalDrag(panel);
};

function bindModalDrag(panel: HTMLElement) {
  const handle = panel.querySelector('[data-modal-drag-handle]') as HTMLElement | null;
  if (!handle) return;

  const onMove = (event: MouseEvent) => {
    if (!modalDragState.active) return;
    modalDragState.offsetX = event.clientX - modalDragState.startX;
    modalDragState.offsetY = event.clientY - modalDragState.startY;
    panel.style.transform = `translate(${modalDragState.offsetX}px, ${modalDragState.offsetY}px)`;
  };

  const onUp = () => {
    modalDragState.active = false;
    handle.style.cursor = 'grab';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  handle.style.cursor = 'grab';
  handle.onmousedown = (event: MouseEvent) => {
    if ((event.target as HTMLElement).closest('.detail-modal-close')) return;
    modalDragState.active = true;
    modalDragState.startX = event.clientX - modalDragState.offsetX;
    modalDragState.startY = event.clientY - modalDragState.offsetY;
    handle.style.cursor = 'grabbing';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };
}

function bindBookmarkRailScrollHints() {
  const rail = document.querySelector('.detail-modal-bookmark-rail') as HTMLElement | null;
  const wrap = document.querySelector('.detail-modal-bookmark-rail-wrap') as HTMLElement | null;
  if (!rail || !wrap) return;

  const updateHints = () => {
    const maxScroll = rail.scrollHeight - rail.clientHeight;
    wrap.classList.toggle('can-scroll-up', rail.scrollTop > 2);
    wrap.classList.toggle('can-scroll-down', rail.scrollTop < maxScroll - 2);
  };

  rail.onscroll = updateHints;
  window.addEventListener('resize', updateHints);
  requestAnimationFrame(updateHints);
}

window.scrollBookmarkRail = function(delta: number) {
  const rail = document.querySelector('.detail-modal-bookmark-rail') as HTMLElement | null;
  if (!rail) return;
  rail.scrollBy({ top: delta, behavior: 'smooth' });
};

window.closeDetailModal = function() {
  const overlay = document.getElementById('content-summary-modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.classList.remove('detail-modal-open');
  modalDragState.offsetX = 0;
  modalDragState.offsetY = 0;
  const panel = overlay.querySelector('.content-summary-modal-panel') as HTMLElement | null;
  if (panel) panel.style.transform = '';
};

window.scrollToSection = function(cardId: string, sectionIndex: number) {
  const overlay = document.getElementById('content-summary-modal-overlay');
  overlay?.querySelectorAll('.bookmark-item').forEach((tab, i) => {
    tab.classList.toggle('active', i === sectionIndex);
  });

  const anchor = document.getElementById(`detail-section-${cardId}-${sectionIndex}`);
  if (anchor) {
    anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }

  const sections = getSections(cardId);
  if (!sections || !sections[sectionIndex]) return;

  const targetTitle = sections[sectionIndex].title.trim();
  const scrollEl = document.getElementById(`detail-modal-scroll-${cardId}`);
  if (!scrollEl) return;

  const headers = scrollEl.querySelectorAll('.content-section-header');
  for (const header of headers) {
    const text = header.textContent?.trim() ?? '';
    if (text.includes(targetTitle) || targetTitle.includes(text)) {
      header.scrollIntoView({ behavior: 'smooth', block: 'start' });
      break;
    }
  }
};

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
