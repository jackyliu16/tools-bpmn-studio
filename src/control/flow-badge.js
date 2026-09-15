/**
 * flow-badge — 边参数投影徽标（B2 方案「边携带参数」的画布呈现）。
 *
 * 边参数是派生投影：`A 出参名 ∩ B 入参名`（见 studio-utils.flowProjectionNames），
 * 不落盘、无独立 schema，因此不会与节点参数产生漂移。
 *
 * 在本 plane 的每条顺序流中点上方渲染 `⇄ a,b` 徽标；无投影则移除。
 * 刷新时机：import.done / commandStack.changed（80ms 节流，与既有
 * rebuildFlowNodeBackrefs 同一节奏）/ diagram.clear。
 */
import { flowProjectionNames } from './studio-utils.js';

const DEBOUNCE_MS = 80;
const OVERLAY_PREFIX = 'studio-flow-badge-';

export default function FlowBadge(eventBus, overlays, elementRegistry, canvas) {
  let timer = null;

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; refresh(); }, DEBOUNCE_MS);
  };

  const refresh = () => {
    const root = canvas.getRootElement();
    if (!root) return;

    for (const element of elementRegistry.getAll()) {
      if (!element.waypoints) continue;
      const bo = element.businessObject;
      if (!bo || !bo.$instanceOf('bpmn:SequenceFlow')) continue;
      if (element.parent !== root) continue; // 仅当前 plane（塌缩子流程内不渲染）

      // diagram-js 的 add(element, type, overlay) 把第二参存为 type；
      // remove 必须用 { type } 精确匹配，用 { id } 会因 element 存在而被忽略、
      // 连带删掉该元素上的其它 overlay。
      const overlayId = OVERLAY_PREFIX + element.id;
      overlays.remove({ element, type: overlayId });

      const projection = flowProjectionNames(
        element.source && element.source.businessObject,
        element.target && element.target.businessObject
      );
      if (!projection.length) continue;

      overlays.add(element, overlayId, {
        position: { top: -22, left: 0 },
        html: `<div class="studio-flow-badge" title="边携带参数（上游出参 ∩ 下游入参）：${escapeHtml(projection.join(', '))}">⇄ ${escapeHtml(projection.join(', '))}</div>`
      });
    }
  };

  eventBus.on('import.done', schedule);
  eventBus.on('commandStack.changed', schedule);
  eventBus.on('diagram.clear', () => {
    if (timer) { clearTimeout(timer); timer = null; }
    for (const element of elementRegistry.getAll()) {
      if (element.waypoints) overlays.remove({ element, type: OVERLAY_PREFIX + element.id });
    }
  });
  eventBus.on('diagram.destroy', () => {
    if (timer) { clearTimeout(timer); timer = null; }
  });

  this.refresh = refresh;
}

FlowBadge.$inject = ['eventBus', 'overlays', 'elementRegistry', 'canvas'];

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}