import { Vector3 } from "three";

const EPS = 0.001;

export const interpolateDomain = (domain: Domain, ranges: Ranges): Domain => {
    return {
        y: [
            (x, z) => ranges.y[0]*domain.y[1](x, z) + (1-ranges.y[0])*domain.y[0](x, z),
            (x, z) => ranges.y[1]*domain.y[1](x, z) + (1-ranges.y[1])*domain.y[0](x, z),
        ],
        z: [
            (x) => ranges.z[0]*domain.z[1](x) + (1-ranges.z[0])*domain.z[0](x),
            (x) => ranges.z[1]*domain.z[1](x) + (1-ranges.z[1])*domain.z[0](x),
        ],
        x: [
            () => ranges.x[0]*domain.x[1]() + (1-ranges.x[0])*domain.x[0](),
            () => ranges.x[1]*domain.x[1]() + (1-ranges.x[1])*domain.x[0](),
        ],
    }
};

const createGridXZ = (domain: Domain, density: number = 4): GridXZ => {
    const [left, right] = [domain.x[0](), domain.x[1]()];
    const numX = Math.ceil(Math.abs(right - left) * density) + 1;
    const dx = (right - left) / (numX - 1);

    const X = new Float32Array(numX);
    const Z: number[] = [];
    const numsZ = new Int32Array(numX);
    const indices: number[] = [];

    let idx = 0;
    for (let i = 0; i < numX; ++i) {
        const x = left + i*dx;
        X[i] = x;
        
        const [back, front] = [domain.z[0](x), domain.z[1](x)];
        const numZ = Math.ceil(Math.abs(front - back) * density) + 1; // check if negative
        numsZ[i] = numZ;
        const dz = (front - back) / (numZ - 1); // check if inf

        for (let k = 0; k < numZ; ++k) {
            const z = back + k*dz;
            Z.push(z);

            if (i !== 0 && k !== 0) {
                const lastNumZ = numsZ[i-1]
                if (k < lastNumZ) {
                    const [botRight, topRight, botLeft, topLeft] = [idx, idx-1, idx-lastNumZ, idx-lastNumZ-1];
                    indices.push(topLeft, botLeft, topRight);
                    indices.push(topRight, botLeft, botRight);
                    if (k === numZ-1) { // check if extra triangles are needed in case vertex shortage
                        for (let j = 0; j < numsZ[i-1] - numZ; ++j) {
                            indices.push(idx, idx-lastNumZ+j, idx-lastNumZ+j+1);
                        }
                    }
                } else { // there is an excess of verts
                    indices.push(idx, idx-1, idx-k-1);
                }
            }

            ++idx;
        }
    }

    return {
        X: X,
        Z: new Float32Array(Z),
        numsZ: numsZ,
        indices: indices,
    };
}

const createSurface = (
    func: (x: number, z: number) => number,
    grid: GridXZ,
): MeshInfo => {
    const vertices: number[] = [];
    const normals: number[] = [];
    
    const p0 = new Vector3;
    const px = new Vector3(EPS, 0, 0), pz = new Vector3(0, 0, EPS);
    const pn = new Vector3;

    let zStart = 0;
    let idx = 0;
    grid.X.forEach((x, i) => {
        for (let k = 0; k < grid.numsZ[i]; ++k) {
            const z = grid.Z[zStart + k];

            // Get vertex values
            p0.x = x;
            p0.z = z;
            p0.y = func(x, z);
            vertices.push(p0.x, p0.y, p0.z);

            // Get normal values
            px.y = func(x + EPS, z) - p0.y;
            pz.y = func(x, z + EPS) - p0.y;
            // if (upIsOut) {
                pn.crossVectors(pz, px).normalize();
            // } else {
            //     pn.crossVectors(px, pz).normalize();
            // }
            normals.push(pn.x, pn.y, pn.z);
            idx++;
        }
        zStart += grid.numsZ[i];
    });

    return {
        vertices: new Float32Array(vertices),
        normals: new Float32Array(normals),
        indices: grid.indices,
    };
};

const createKnittedSurface = (
    verts1: Float32Array,
    verts2: Float32Array,
    normals: Float32Array,
): MeshInfo => {
    const num = Math.floor(verts1.length / 3);
    const vertices = Float32Array.of(...verts1, ...verts2);
    normals = Float32Array.of(...normals, ...normals);
    const indices: number[] = [];
    for (let i = 0; i < num-1; ++i) {
        indices.push(i, i+1, i+num);
        indices.push(i+num, i+1, i+num+1);
    }
    return {
        vertices: vertices,
        normals: normals,
        indices: indices,
    };
}


const createVerticalSurface = (
    lowerY: (x: number, z: number) => number,
    upperY: (x: number, z: number) => number,
    curve: (u: number) => [number, number],
    U: Float32Array,
): MeshInfo => {
    const upperVerts = new Float32Array(3 * U.length);
    const lowerVerts = new Float32Array(3 * U.length);
    const normals = new Float32Array(3 * U.length);

    const UP = new Vector3(0, 1, 0);
    const tangent = new Vector3(0, 0, 0);
    const normal = new Vector3(0, 0, 0);

    U.forEach((u, i) => {
        const idx = 3*i
        const [x, z] = curve(u);
        upperVerts.set([x, upperY(x, z), z], idx);
        lowerVerts.set([x, lowerY(x, z), z], idx);

        const [x1, z1] = curve(u + EPS);
        tangent.x = x1 - x; tangent.z = z1 - z;
        normal.crossVectors(tangent, UP).normalize();
        normals.set(normal.toArray(), idx);
    });
    return createKnittedSurface(upperVerts, lowerVerts, normals);
}

export const createVolume = (domain: Domain): MeshInfo[] => {
    const grid = createGridXZ(domain);

    const yMesh = domain.y.map(func => createSurface(func, grid));
    const zMesh = domain.z.map(func => createVerticalSurface(
        ...domain.y,
        x => [x, func(x)],
        grid.X,
    ));

    const num = grid.numsZ.at(-1);
    if (!num) throw new Error("The mesh has zero depth, there should at least be one vertex");
    const xMesh = domain.x.map((func, i) => createVerticalSurface(
        ...domain.y,
        z => [func(), z],
        i === 0 ? grid.Z.slice(0, grid.numsZ[0]) : grid.Z.slice(-num),
    ));
    return [...yMesh, ...zMesh, ...xMesh];
};
