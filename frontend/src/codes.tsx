/**
 * Barcodes and QR codes drawn as pictures, for printing.
 *
 * The barcode is Code 128 (set B), which every ordinary scanner reads. A patient code is printed
 * without its "PAT-" start so the bars fit across a 2 inch label; the scan service accepts both.
 */
import qrcode from 'qrcode-generator';

// Bar and space widths for Code 128 values 0 to 105, then the stop pattern.
const PATTERNS = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 ' +
  '221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 ' +
  '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 ' +
  '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 ' +
  '231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 ' +
  '112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 ' +
  '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 ' +
  '114131 311141 411131 211412 211214 211232 2331112'
).split(' ');
const START_B = 104;
const STOP = 106;

/** The Code 128 values for a text: start, one per character, check value, stop. */
export function code128Values(text: string) {
  const values = [START_B];
  for (const char of text) {
    const value = char.charCodeAt(0) - 32;
    if (value < 0 || value > 94) throw new Error('This text cannot be printed as a barcode.');
    values.push(value);
  }
  const check = values.reduce((sum, value, index) => sum + value * Math.max(index, 1), 0) % 103;
  return [...values, check, STOP];
}

/** Widths of bars and spaces in turn, starting with a bar. */
export function code128Widths(text: string) {
  return code128Values(text).flatMap((value) => PATTERNS[value].split('').map(Number));
}

/** The text a patient's barcode carries: the code without its "PAT-" start. */
export const barcodeText = (patientCode: string) => patientCode.replace(/^PAT-/i, '').toUpperCase();

export function Barcode({ value, className }: { value: string; className?: string }) {
  let widths: number[];
  try {
    widths = code128Widths(value);
  } catch {
    return null;
  }
  const total = widths.reduce((sum, width) => sum + width, 0);
  let x = 0;
  const bars: [number, number][] = [];
  widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push([x, width]);
    x += width;
  });
  return (
    <svg
      className={className}
      viewBox={`0 0 ${total} 10`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Patient barcode"
      shapeRendering="crispEdges"
    >
      {bars.map(([left, width]) => (
        <rect key={left} x={left} y={0} width={width} height={10} fill="#000" />
      ))}
    </svg>
  );
}

export function QrCode({ text, className, label }: { text: string; className?: string; label: string }) {
  const code = qrcode(0, 'M');
  code.addData(text);
  code.make();
  const size = code.getModuleCount();
  const squares: string[] = [];
  for (let row = 0; row < size; row += 1)
    for (let column = 0; column < size; column += 1)
      if (code.isDark(row, column)) squares.push(`M${column} ${row}h1v1h-1z`);
  return (
    <svg
      className={className}
      viewBox={`-2 -2 ${size + 4} ${size + 4}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect x={-2} y={-2} width={size + 4} height={size + 4} fill="#fff" />
      <path d={squares.join('')} fill="#000" />
    </svg>
  );
}
