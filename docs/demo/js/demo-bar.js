// The strip across the top of every demo page. Hidden inside the side-by-side view, which has its own.
if (window.self === window.top) {
  const style = document.createElement('style');
  style.textContent = `
    .demo-bar { display: flex; align-items: center; gap: 12px; padding: 6px 12px; background: #0d646b; color: #fff; font: 14px/1.3 "Atkinson Hyperlegible", Verdana, sans-serif; }
    .demo-bar span { flex: 1; min-width: 0; }
    .demo-bar a, .demo-bar button { flex: none; padding: 2px 0; border: 0; background: none; color: #fff; font: inherit; font-weight: 700; text-decoration: underline; cursor: pointer; }
  `;
  const bar = document.createElement('div');
  bar.className = 'demo-bar';
  bar.innerHTML = `<span>Demo. Made-up farm, saved only in this browser.</span>
    <button type="button">Start over</button><a href="../">About</a>`;
  bar.querySelector('button').onclick = async () => {
    await fetch('api/demo-reset', { method: 'POST' });
    location.reload();
  };
  document.head.append(style);
  document.body.prepend(bar);
}
