import image from '../../../../data/straight-leg-size-chart.b64?raw';
export function GET() {
  return new Response(Uint8Array.from(atob(image.trim()), c => c.charCodeAt(0)), {
    headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=86400' },
  });
}
