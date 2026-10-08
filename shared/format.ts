// Number formatting, identical to the original ui.js helpers.
export const f2 = (x: number) => x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fi = (x: number) => Math.round(x).toLocaleString('en-US');
export const money = (x: number) => (x < 0 ? '−$' : '+$') + fi(Math.abs(x));
export const sgn = (x: number) => x > 0 ? 'up' : x < 0 ? 'down' : '';
export const esc = (s: unknown) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
