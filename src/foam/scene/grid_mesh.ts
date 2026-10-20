const N = 16; // grid subdivisions per element: enough vertices to bend, bulge and wave

/**
 * One unit quad as an (N+1)^2 grid of uvs, shared by every element instance.
 * `tris` fills it; `lines` is its outline only, along the grid vertices so the
 * wire view bends with the mesh.
 */
export function gridMesh() {
  const uvs: number[] = [];
  for (let y = 0; y <= N; y++) for (let x = 0; x <= N; x++) uvs.push(x / N, y / N);
  const id = (x: number, y: number) => y * (N + 1) + x;
  const tris: number[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      tris.push(id(x, y), id(x + 1, y), id(x, y + 1), id(x + 1, y), id(x + 1, y + 1), id(x, y + 1));
  const lines: number[] = [];
  for (let i = 0; i < N; i++)
    lines.push(id(i, 0), id(i + 1, 0), id(i, N), id(i + 1, N), id(0, i), id(0, i + 1), id(N, i), id(N, i + 1));
  return { uvs: new Float32Array(uvs), tris: new Uint16Array(tris), lines: new Uint16Array(lines) };
}
