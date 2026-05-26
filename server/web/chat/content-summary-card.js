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
let expandedCards = new Set<string>();

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
  news: "资讯日报",
  article: "长文详情",
  search_result: "搜索结果",
  webpage: "网页内容",
  document: "文档资料",
  data: "调研报告",
  list: "清单列表",
  multi_section: "分类汇总",
  table: "数据表格",
  general: "详细内容",
};

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

  const isExpanded = expandedCards.has(data.id);
  const displayLabel = CATEGORY_LABELS[data.category] ?? data.cardLabel ?? "详情";

  let html = `<div class="content-summary-v2" data-category="${data.category}">`;

  if (briefText && briefText.trim()) {
    html += `<div class="brief-points">${escapeHtml(briefText).replace(/\n/g, '<br/>')}</div>`;
  }

  html += `
    <div class="detail-card ${data.category}" data-card-id="${data.id}" onclick="toggleDetailCard('${data.id}')">
      <div class="detail-card-left">
        <span class="detail-card-icon">${escapeHtml(data.cardIcon)}</span>
      </div>
      <div class="detail-card-center">
        <div class="detail-card-title">${escapeHtml(data.title)}</div>
        <div class="detail-card-subtitle">${displayLabel}${data.sections ? ` · ${data.sections.length}个板块` : ''}</div>
      </div>
      <div class="detail-card-right">
        <svg class="detail-lines" viewBox="0 0 24 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="4" y="2" width="16" height="2" rx="1" fill="currentColor" opacity="0.6"/>
          <rect x="4" y="7" width="12" height="2" rx="1" fill="currentColor" opacity="0.4"/>
          <rect x="4" y="12" width="14" height="2" rx="1" fill="currentColor" opacity="0.3"/>
        </svg>
      </div>
    </div>
  `;

  if (isExpanded) {
    html += renderExpandedContent(data);
  }

  html += `</div>`;

  return html;
}

function renderExpandedContent(data: ContentSummaryDataV2): string {
  const content = getDetailContent(data.id) ?? '暂无详细内容';
  const sections = getSections(data.id);

  let sectionNavHtml = '';
  if (sections && sections.length > 1) {
    sectionNavHtml = `
      <div class="section-nav">
        ${sections.map((s, i) => `
          <button class="section-tab${i === 0 ? ' active' : ''}" onclick="event.stopPropagation(); scrollToSection('${data.id}', ${i})">
            ${escapeHtml(s.title)} (${s.pointCount})
          </button>
        `).join('')}
      </div>
    `;
  }

  return `
    <div class="detail-content" id="detail-${data.id}">
      ${sectionNavHtml}
      <div class="detail-text">${formatDetailContent(content)}</div>
      ${renderMetadata(data.metadata)}
    </div>
  `;
}

function formatDetailContent(content: string): string {
  const lines = content.split('\n');
  
  return lines.map(line => {
    const trimmed = line.trim();
    
    if (/^(一|二|三|四|五|六|七|八|九|十)[、.．]/.test(trimmed)) {
      return `<div class="content-section-header">${escapeHtml(trimmed)}</div>`;
    }
    
    if (/^#{1,3}\s+/.test(trimmed)) {
      return `<div class="content-section-header">${escapeHtml(trimmed.replace(/^#+\s*/, ''))}</div>`;
    }
    
    if (/^[\s]*[-•*→▸‣⁃◦·]\s+/.test(trimmed)) {
      return `<div class="content-list-item">${escapeHtml(trimmed.replace(/^[\s]*[-•*→▸‣⁃◦·]\s*/, ''))}</div>`;
    }
    
    if (trimmed.includes('|') && trimmed.split('|').length >= 4) {
      return `<div class="content-table-row">${escapeHtml(trimmed)}</div>`;
    }
    
    if (trimmed.length > 100) {
      return `<div class="content-paragraph">${escapeHtml(trimmed)}</div>`;
    }
    
    if (trimmed) {
      return `<div class="content-line">${escapeHtml(trimmed)}</div>`;
    }
    
    return '';
  }).join('');
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

window.toggleDetailCard = function(id: string) {
  if (expandedCards.has(id)) {
    expandedCards.delete(id);
  } else {
    expandedCards.add(id);
  }

  const container = document.querySelector(`[data-card-id="${id}"]`)?.closest('.content-summary-v2');
  if (!container) return;

  const existingDetail = container.querySelector('.detail-content');
  
  if (expandedCards.has(id)) {
    if (existingDetail) {
      existingDetail.style.display = '';
    } else {
      const summaryData = window.__contentSummaries?.[id];
      if (summaryData) {
        const detailEl = document.createElement('div');
        detailEl.className = 'detail-content';
        detailEl.id = `detail-${id}`;
        detailEl.innerHTML = renderExpandedContent(summaryData);
        container.appendChild(detailEl);
      }
    }
    container.querySelector('[data-card-id]')?.classList.add('expanded');
  } else {
    if (existingDetail) {
      existingDetail.style.display = 'none';
    }
    container.querySelector('[data-card-id]')?.classList.remove('expanded');
  }
};

window.scrollToSection = function(cardId: string, sectionIndex: number) {
  const tabs = document.querySelectorAll(`[data-card-id="${cardId}"]`).forEach(el => {
    el.closest('.content-summary-v2')?.querySelectorAll('.section-tab').forEach((tab, i) => {
      tab.classList.toggle('active', i === sectionIndex);
    });
  });
};

function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
