declare module 'vt-pbf' {
  export function fromGeojsonVt(tiles: { [layerName: string]: any }): Uint8Array;
  export function fromVectorTileJs(tile: any): Uint8Array;
}
