// One flexible DOM widget owns the space below the node's native ports/widgets.
// Measure only fixed controls: measuring panel.scrollHeight would include the
// preview's allocated height and cause a resize feedback loop.
export function responsiveEditor(node, editor) {
    const root = editor.root, preview = root.querySelector(".ea-grid,.ea-export-media");
    root.classList.add("ea-node-panel");
    // Do not make the default node height a permanent minimum. Saved compact
    // sizes must survive configure before the first DOM measurement happens.
    let minimum = 125, frame = 0, disposed = false;
    const number = value => parseFloat(value) || 0;
    const measure = () => {
        frame = 0;
        if (disposed || !root.isConnected || !root.clientWidth) return;
        const style = getComputedStyle(root);
        let fixed = number(style.paddingTop) + number(style.paddingBottom) + number(style.borderTopWidth) + number(style.borderBottomWidth);
        for (const child of root.children) {
            const css = getComputedStyle(child);
            if (css.display === "none") continue;
            fixed += (child === preview ? 125 : child.offsetHeight) + number(css.marginTop) + number(css.marginBottom);
        }
        const next = Math.ceil(fixed);
        if (Math.abs(next - minimum) < 1) return;
        minimum = next;
        // Adding directories or opening media settings may need more room, but
        // loading previews must never discard the user's extra node height.
        const required = node.computeSize?.()[1] ?? minimum + 90;
        if (node.size[1] < required) node.setSize([node.size[0], required]);
        node.setDirtyCanvas?.(true, true);
    };
    const refresh = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(refresh);
    observer.observe(root);
    for (const child of root.children) if (child !== preview) observer.observe(child);
    root.addEventListener("toggle", refresh, true);
    refresh();
    return {
        options: { serialize: false, hideOnZoom: false, getMinHeight: () => minimum, getHeight: () => "100%", afterResize: refresh },
        refresh,
        dispose() { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); root.removeEventListener("toggle", refresh, true); },
    };
}
