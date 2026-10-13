// Standalone preview of the real exported file. The MIT Three.js modules are
// served locally and loaded only when a supported model is displayed.
const SUPPORTED = new Set(["glb", "gltf", "obj", "stl"]);
let modulesPromise;

export function canPreviewModel(ext) { return SUPPORTED.has(String(ext || "").toLowerCase()); }

function loadModules(apiURL) {
    if (!modulesPromise) {
        const base = new URL(apiURL("/eagle_assets/vendor/"), location.href);
        const module = name => import(new URL(name + ".mjs", base).href);
        modulesPromise = Promise.all([module("three.module"), module("OrbitControls"), module("GLTFLoader"),
            module("OBJLoader"), module("STLLoader"), module("MTLLoader"), module("meshopt_decoder.module")]);
        modulesPromise.catch(() => { modulesPromise = null; });
    }
    return modulesPromise;
}

function disposeScene(scene) {
    const disposed = new Set();
    scene?.traverse(object => {
        if (object.geometry && !disposed.has(object.geometry)) { object.geometry.dispose(); disposed.add(object.geometry); }
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (!material || disposed.has(material)) continue;
            for (const texture of Object.values(material)) if (texture?.isTexture && !disposed.has(texture)) {
                texture.dispose(); texture.source?.data?.close?.(); disposed.add(texture);
            }
            material.dispose(); disposed.add(material);
        }
    });
}

export function createModelPreview(container, { url, ext, apiURL }) {
    let disposed = false, renderer, controls, observer, scene, camera, object;
    const render = () => { if (!disposed && renderer && scene && camera) renderer.render(scene, camera); };
    const resize = () => {
        if (disposed || !renderer) return;
        const width = Math.max(100, container.clientWidth), height = Math.max(100, container.clientHeight || 280);
        renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render();
    };
    const fit = () => {
        if (!object) return;
        const THREE = scene.userData.THREE, bounds = new THREE.Box3().setFromObject(object), size = bounds.getSize(new THREE.Vector3());
        const radius = size.length() / 2;
        if (bounds.isEmpty() || !Number.isFinite(radius) || radius <= 0) throw new Error("模型没有可显示的几何体");
        const center = bounds.getCenter(new THREE.Vector3()); object.position.sub(center);
        const distance = radius / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 1.35;
        camera.near = Math.max(radius / 1000, 0.00001); camera.far = Math.max(radius * 1000, 10);
        camera.position.set(distance * 0.75, distance * 0.5, distance); camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0); controls.minDistance = radius / 20; controls.maxDistance = radius * 100;
        controls.update(); render();
    };
    const dispose = () => {
        if (disposed) return;
        disposed = true; observer?.disconnect(); controls?.dispose(); disposeScene(scene);
        renderer?.dispose(); renderer?.forceContextLoss(); renderer?.domElement.remove();
    };
    const ready = (async () => {
        if (!canPreviewModel(ext)) throw new Error("此格式暂不支持节点内 3D 预览");
        const [THREE, { OrbitControls }, { GLTFLoader }, { OBJLoader }, { STLLoader }, { MTLLoader }, { MeshoptDecoder }] = await loadModules(apiURL);
        if (disposed) return;
        const mainURL = new URL(url, location.href), resourceBase = new URL(".", mainURL);
        const manager = new THREE.LoadingManager();
        manager.setURLModifier(resource => {
            if (resource.startsWith("data:") || resource.startsWith(`blob:${location.origin}/`)) return resource;
            const resolved = new URL(resource, resourceBase);
            if (resolved.origin !== mainURL.origin || !resolved.pathname.startsWith(resourceBase.pathname)) {
                throw new Error("模型资源必须位于同一预览目录；未加载外部链接");
            }
            return resolved.href;
        });
        scene = new THREE.Scene(); scene.background = new THREE.Color("#17202c"); scene.userData.THREE = THREE;
        camera = new THREE.PerspectiveCamera(42, 1, 0.01, 1000);
        renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.domElement.setAttribute("aria-label", "3D 模型预览"); renderer.domElement.dataset.modelReady = "false";
        container.append(renderer.domElement);
        controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = false; controls.addEventListener("change", render);
        scene.add(new THREE.HemisphereLight(0xffffff, 0x596c89, 2.5));
        const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(3, 5, 4); scene.add(light);
        resize(); observer = new ResizeObserver(resize); observer.observe(container);
        let animations;
        if (ext === "glb" || ext === "gltf") {
            const loader = new GLTFLoader(manager); loader.setMeshoptDecoder(MeshoptDecoder);
            const gltf = await loader.loadAsync(mainURL.href); object = gltf.scene || gltf.scenes?.[0]; animations = gltf.animations;
        } else if (ext === "obj") {
            const response = await fetch(mainURL.href);
            if (!response.ok) throw new Error("无法读取 OBJ 文件");
            const text = await response.text(), loader = new OBJLoader(manager), parsed = loader.parse(text);
            const materials = [];
            for (const filename of parsed.materialLibraries || []) {
                const materialURL = manager.resolveURL(new URL(filename, resourceBase).href);
                const material = await new MTLLoader(manager).loadAsync(materialURL); material.preload(); materials.push(material);
            }
            if (materials.length) { loader.setMaterials({ create: name => materials.find(material => material.materialsInfo[name])?.create(name) || materials[0].create(name) }); object = loader.parse(text); disposeScene(parsed); }
            else object = parsed;
        } else {
            const geometry = await new STLLoader(manager).loadAsync(mainURL.href);
            object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x81b6d7, roughness: 0.6, side: THREE.DoubleSide }));
        }
        if (disposed) { disposeScene(object); return; }
        if (!object) throw new Error("模型没有场景内容");
        // Show the actual model's initial pose. Animation data stays in the
        // exported file; the preview does not change the workflow output.
        if (animations?.length) { const mixer = new THREE.AnimationMixer(object); mixer.clipAction(animations[0]).play(); mixer.update(0); }
        scene.add(object); fit(); render();
        renderer.domElement.dataset.modelReady = "true"; container.dataset.modelReady = "true";
    })();
    return { ready, dispose, reset: fit };
}
