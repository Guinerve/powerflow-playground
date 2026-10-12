export interface Cx {
  re: number;
  im: number;
}
export const cx = (re: number, im = 0): Cx => ({ re, im });
export const add = (a: Cx, b: Cx): Cx => cx(a.re + b.re, a.im + b.im);
export const sub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
export const mul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
export const scale = (a: Cx, k: number): Cx => cx(a.re * k, a.im * k);
export const neg = (a: Cx): Cx => cx(-a.re, -a.im);
export const conj = (a: Cx): Cx => cx(a.re, -a.im);
export const inv = (a: Cx): Cx => {
  const d = a.re * a.re + a.im * a.im;
  return cx(a.re / d, -a.im / d);
};
export const polar = (mag: number, ang: number): Cx => cx(mag * Math.cos(ang), mag * Math.sin(ang));
export const abs = (a: Cx): number => Math.hypot(a.re, a.im);
