import fs from 'fs';
import { NodeIO } from '@gltf-transform/core';

const io = new NodeIO();
const document = await io.read('public/models/lobsters/FlatIvyBase.glb');
const root = document.getRoot();

for (const material of root.listMaterials()) {
    console.log("Material:", material.getName() || "unnamed");
    console.log("Base Color Factor:", material.getBaseColorFactor());
    console.log("Metallic Factor:", material.getMetallicFactor());
    console.log("Roughness Factor:", material.getRoughnessFactor());
    const baseColorTexture = material.getBaseColorTexture();
    console.log("Has Base Color Texture:", !!baseColorTexture);
    if (baseColorTexture) {
        console.log("Texture MIME:", baseColorTexture.getMimeType());
    }
}
for (const mesh of root.listMeshes()) {
     for (const prim of mesh.listPrimitives()) {
         console.log("Primitive attributes:", prim.listSemantics());
     }
}
