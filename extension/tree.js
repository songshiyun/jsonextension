const PAGE_SIZE = 200;

export class JSONTree {
  constructor(container, onSelect) {
    this.container = container;
    this.onSelect = onSelect;
    this.records = [];
    this.expanded = new Set([0]);
    this.query = '';
    this.limit = PAGE_SIZE;
    this.selected = 0;
  }

  setDocument(source, document) {
    this.source = source;
    this.records = [];
    const visit = (node, parent = -1, depth = 0, index = 0) => {
      const id = this.records.length;
      this.records.push({ id, node, parent, depth, index, end: 0 });
      node.children?.forEach((child, childIndex) => visit(child, id, depth + 1, childIndex));
      this.records[id].end = this.records.length;
    };
    visit(document.root);
    this.expanded = new Set([0]);
    this.selected = 0;
    this.limit = PAGE_SIZE;
    this.search(this.query);
    this.select(0, false);
  }

  pathFor(record) {
    const parts = [];
    while (record.parent !== -1) {
      const parent = this.records[record.parent];
      if (parent.node.type === 'array') parts.push(`[${record.index}]`);
      else parts.push(/^[A-Za-z_$][\w$]*$/.test(record.node.key) ? `.${record.node.key}` : `[${JSON.stringify(record.node.key)}]`);
      record = parent;
    }
    return '$' + parts.reverse().join('');
  }

  select(id, highlight = true) {
    const record = this.records[id];
    if (!record) return;
    this.selected = id;
    for (const row of this.container.querySelectorAll('[data-node]')) {
      row.classList.toggle('selected', Number(row.dataset.node) === id);
      row.setAttribute('aria-selected', String(Number(row.dataset.node) === id));
    }
    this.onSelect({ path: this.pathFor(record), start: record.node.start, end: record.node.end, type: record.node.type, highlight });
  }

  search(query) {
    this.query = query.trim().toLocaleLowerCase();
    this.limit = PAGE_SIZE;
    this.matches = new Set();
    this.included = new Set();
    if (this.query) {
      for (const record of this.records) {
        const node = record.node;
        const key = node.key ?? (record.parent >= 0 ? String(record.index) : '$');
        let value = node.children ? '' : this.source.slice(node.start, node.end);
        if (node.type === 'string') value = JSON.parse(value);
        if (`${key} ${value}`.toLocaleLowerCase().includes(this.query)) {
          this.matches.add(record.id);
          let parent = record;
          while (parent && !this.included.has(parent.id)) {
            this.included.add(parent.id);
            parent = this.records[parent.parent];
          }
        }
      }
    }
    this.render();
    return this.matches.size;
  }

  expandAll() {
    this.expanded = new Set(this.records.filter(record => record.node.children?.length).map(record => record.id));
    this.limit = PAGE_SIZE;
    this.render();
  }

  collapseAll() { this.expanded.clear(); this.limit = PAGE_SIZE; this.render(); }

  render() {
    const fragment = document.createDocumentFragment();
    let drawn = 0;
    let visible = 0;
    for (let i = 0; i < this.records.length;) {
      const record = this.records[i];
      if (this.query && !this.included.has(i)) { i = record.end; continue; }
      visible++;
      if (drawn < this.limit) { fragment.append(this.createRow(record)); drawn++; }
      i = this.query || this.expanded.has(i) ? i + 1 : record.end;
    }
    if (!visible && this.query) {
      const empty = document.createElement('p');
      empty.className = 'tree-empty';
      empty.textContent = '没有匹配的字段或值';
      fragment.append(empty);
    }
    if (visible > drawn) {
      const more = document.createElement('button');
      more.className = 'show-more';
      more.textContent = `再显示 ${Math.min(PAGE_SIZE, visible - drawn)} 项 · 还有 ${(visible - drawn).toLocaleString()} 项`;
      more.addEventListener('click', () => { this.limit += PAGE_SIZE; this.render(); });
      fragment.append(more);
    }
    this.container.replaceChildren(fragment);
  }

  createRow(record) {
    const { node, id, depth } = record;
    const row = document.createElement('div');
    row.className = `tree-row${this.selected === id ? ' selected' : ''}${this.matches?.has(id) ? ' match' : ''}`;
    row.dataset.node = id;
    row.style.paddingLeft = `${12 + Math.min(depth, 40) * 18}px`;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-level', String(depth + 1));
    row.setAttribute('aria-selected', String(this.selected === id));
    row.tabIndex = 0;
    const toggle = document.createElement('button');
    toggle.className = 'tree-toggle';
    toggle.tabIndex = -1;
    const expandable = Boolean(node.children?.length);
    const open = Boolean(this.query || this.expanded.has(id));
    toggle.textContent = expandable ? (open ? '⌄' : '›') : '·';
    toggle.disabled = !expandable;
    toggle.setAttribute('aria-label', open ? '折叠节点' : '展开节点');
    if (expandable) row.setAttribute('aria-expanded', String(open));
    const toggleNode = () => {
      if (!expandable || this.query) return;
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      this.render();
      this.container.querySelector(`[data-node="${id}"]`)?.focus({ preventScroll: true });
    };
    toggle.addEventListener('click', event => { event.stopPropagation(); toggleNode(); });
    const key = document.createElement('span');
    key.className = 'tree-key';
    key.textContent = id === 0 ? '$' : (node.keyRaw ?? String(record.index));
    const colon = document.createElement('span');
    colon.className = 'tree-colon';
    colon.textContent = ':';
    const value = document.createElement('span');
    value.className = `tree-value ${node.type}`;
    if (node.children) value.textContent = node.type === 'object' ? `{ ${node.children.length} 个字段 }` : `[ ${node.children.length} 项 ]`;
    else {
      const raw = this.source.slice(node.start, node.end);
      value.textContent = raw.length > 180 ? `${raw.slice(0, 180)}…` : raw;
      value.title = raw.length <= 4096 ? raw : '点击节点，在左侧查看完整值';
    }
    row.append(toggle, key, colon, value);
    row.addEventListener('click', () => this.select(id));
    row.addEventListener('keydown', event => {
      if (['Enter', ' '].includes(event.key)) { event.preventDefault(); this.select(id); }
      if (event.key === 'ArrowRight' && !open || event.key === 'ArrowLeft' && open) { event.preventDefault(); toggleNode(); }
      if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
        if (next?.dataset.node) { next.focus(); this.select(Number(next.dataset.node)); }
      }
    });
    return row;
  }
}
