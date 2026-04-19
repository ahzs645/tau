/* oxlint-disable complexity -- Label/line sizing and camera-facing math in a single component */
import { useEffect, useRef, useState, useMemo } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  LabelTextGeometry,
  LabelBackgroundGeometry,
} from '#components/geometry/graphics/three/geometries/label-geometry.js';
import {
  detectSnapPoints,
  findClosestSnapPoint,
} from '#components/geometry/graphics/three/utils/snap-detection.utils.js';
import type { SnapPoint } from '#components/geometry/graphics/three/utils/snap-detection.utils.js';
import { computeAxisRotationForCamera } from '#components/geometry/graphics/three/utils/rotation.utils.js';
import { matcapMaterial } from '#components/geometry/graphics/three/materials/matcap-material.js';
import { sceneTag, sceneTagData, hasSceneTag } from '#components/geometry/graphics/three/utils/scene-tags.js';
import { useGraphics, useGraphicsSelector } from '#hooks/use-graphics.js';

function calculateScaleFromCamera(position: THREE.Vector3, camera: THREE.Camera): number {
  const distanceToCamera = camera.position.distanceTo(position);

  let factor: number;

  // Handle orthographic camera
  if ('isOrthographicCamera' in camera && camera.isOrthographicCamera) {
    const orthoCamera = camera as THREE.OrthographicCamera;
    factor = (orthoCamera.top - orthoCamera.bottom) / orthoCamera.zoom;
  } else {
    // Handle perspective camera with FOV consideration
    const perspCamera = camera as THREE.PerspectiveCamera;
    factor = distanceToCamera * Math.min((1.9 * Math.tan((Math.PI * perspCamera.fov) / 360)) / perspCamera.zoom, 7);
  }

  const size = 1; // Base size (equivalent to this.size in transform-controls)
  return (factor * size) / 4000;
}

// ── Module-scope scratch objects for useFrame callbacks (avoids per-frame GC pressure) ──

// SnapPointIndicator scratch
const _snapDirection = new THREE.Vector3();
const _snapQuaternion = new THREE.Quaternion();
const _snapUp = new THREE.Vector3(0, 1, 0);

// MeasurementLine scratch
const _baseQuat = new THREE.Quaternion();
const _currentNormal = new THREE.Vector3();
const _axisRotation = new THREE.Quaternion();
const _finalQuat = new THREE.Quaternion();
const _flipQuat = new THREE.Quaternion();
const _labelNormal = new THREE.Vector3();
const _labelUp = new THREE.Vector3();
const _cameraUp = new THREE.Vector3();
const _cameraUpProjected = new THREE.Vector3();
// oxlint-disable-next-line unicorn-js/prevent-abbreviations -- dir refers to direction vector, not directory
const _lineDir = new THREE.Vector3();
const _coneOffset = new THREE.Vector3();

export function MeasureTool(): React.JSX.Element {
  const { camera, gl, scene } = useThree();
  const graphicsActor = useGraphics();
  const geometryKey = useGraphicsSelector((state) => state.context.geometryKey);
  const measurements = useGraphicsSelector((state) => state.context.measurements);
  const currentStart = useGraphicsSelector((state) => state.context.currentMeasurementStart);
  const snapDistance = useGraphicsSelector((state) => state.context.measureSnapDistance);
  const lengthFactor = useGraphicsSelector((state) => state.context.units.length.factor);
  const lengthSymbol = useGraphicsSelector((state) => state.context.units.length.symbol);
  const hoveredMeasurementId = useGraphicsSelector((state) => state.context.hoveredMeasurementId);
  const isMeasureActive = useGraphicsSelector((state) => state.context.isMeasureActive);

  const [hoveredSnapPoints, setHoveredSnapPoints] = useState<SnapPoint[]>([]);
  const [activeSnapPoint, setActiveSnapPoint] = useState<SnapPoint | undefined>();
  const [mousePosition, setMousePosition] = useState<THREE.Vector3 | undefined>();
  const lastSnapPointsRef = useRef<SnapPoint[] | undefined>(undefined);

  // Refs for values that change rapidly (every mouse move) so the event-listener
  // effect doesn't tear down and re-add 4 DOM listeners per mouse event.
  const activeSnapPointRef = useRef(activeSnapPoint);
  activeSnapPointRef.current = activeSnapPoint;
  const mousePositionRef = useRef(mousePosition);
  mousePositionRef.current = mousePosition;
  const currentStartRef = useRef(currentStart);
  currentStartRef.current = currentStart;

  const raycasterRef = useRef(new THREE.Raycaster());
  const mouseRef = useRef(new THREE.Vector2());
  const pointerDownOnMeshRef = useRef(false);
  const mouseIsDownRef = useRef(false);
  const startCameraQuatRef = useRef(new THREE.Quaternion());
  const startCameraPosRef = useRef(new THREE.Vector3());

  // Cache mesh list to avoid expensive scene.traverse() on every mouse event.
  // Invalidated when geometryKey changes (new geometry loaded/unloaded).
  const cachedMeshesRef = useRef<THREE.Mesh[]>([]);
  const cachedMeshKeyRef = useRef<string | undefined>(undefined);
  // Keep scene ref in sync for getCachedMeshes (stable callback reference)
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const geometryKeyRef = useRef(geometryKey);
  geometryKeyRef.current = geometryKey;

  // Cache detectSnapPoints results keyed by (mesh.id, faceIndex) to avoid
  // running the expensive geometry pipeline on every mouse move over the same face.
  const snapCacheRef = useRef(new Map<string, SnapPoint[]>());

  const getCachedMeshes = useRef((): THREE.Mesh[] => {
    const currentKey = geometryKeyRef.current;
    if (currentKey === cachedMeshKeyRef.current) {
      return cachedMeshesRef.current;
    }

    const meshes: THREE.Mesh[] = [];
    sceneRef.current.traverse((object) => {
      if (object instanceof THREE.Mesh && object.visible && !hasSceneTag(object, sceneTag.measurementUi)) {
        meshes.push(object as THREE.Mesh);
      }
    });
    cachedMeshesRef.current = meshes;
    cachedMeshKeyRef.current = currentKey;
    // Invalidate snap point cache when geometry changes
    snapCacheRef.current.clear();
    return meshes;
  }).current;

  // Handle mouse move for snapping
  useEffect(() => {
    // Only enable interactive listeners when measure mode is active
    if (!isMeasureActive) {
      return undefined;
    }

    const handleMouseMove = (event: MouseEvent): void => {
      const rect = gl.domElement.getBoundingClientRect();
      mouseRef.current.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouseRef.current.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycasterRef.current.setFromCamera(mouseRef.current, camera);

      // Get all meshes in scene, using cached list when geometry hasn't changed
      const meshes = getCachedMeshes();

      // Find the closest intersected mesh (top-most object)
      const intersects = raycasterRef.current.intersectObjects(meshes, true);
      const firstIntersection = intersects[0];

      // Only show snap points for the closest/top-most intersected object.
      // If there is no intersection, fall back to the last detected face's snap points.
      let allSnapPoints: SnapPoint[] = [];
      if (firstIntersection?.object) {
        const topMesh = firstIntersection.object as THREE.Mesh;
        // Cache by mesh ID + face index to avoid re-running the expensive geometry
        // pipeline when hovering over the same face on consecutive mouse moves.
        const cacheKey = `${topMesh.id}:${firstIntersection.faceIndex ?? -1}`;
        const cached = snapCacheRef.current.get(cacheKey);
        if (cached) {
          allSnapPoints = cached;
        } else {
          allSnapPoints = detectSnapPoints(topMesh, raycasterRef.current);
          snapCacheRef.current.set(cacheKey, allSnapPoints);
        }

        lastSnapPointsRef.current = allSnapPoints;
      } else if (lastSnapPointsRef.current?.length) {
        allSnapPoints = lastSnapPointsRef.current;
      }

      setHoveredSnapPoints(allSnapPoints);

      const closest = findClosestSnapPoint(allSnapPoints, {
        mousePos: mouseRef.current,
        camera,
        canvas: gl.domElement,
        snapDistancePx: snapDistance,
        snapPointBufferPx: 15, // Add buffer for hover persistence
      });
      setActiveSnapPoint(closest);

      // Update mouse position for preview line
      if (closest) {
        setMousePosition(closest.position);
      } else if (firstIntersection) {
        setMousePosition(firstIntersection.point);
      } else if (lastSnapPointsRef.current?.[0]) {
        // Use the first snap point as a stable mouse position proxy when off-face
        setMousePosition(lastSnapPointsRef.current[0].position);
      }
    };

    const handlePointerDown = (event: MouseEvent): void => {
      // Track camera state at mouse down to detect rotations/translations during drag
      if (event.button === 0 || event.button === 2) {
        startCameraQuatRef.current.copy(camera.quaternion);
        startCameraPosRef.current.copy(camera.position);
        mouseIsDownRef.current = true;
      }

      // Only handle left clicks for measurement from here
      if (event.button !== 0) {
        return;
      }

      // Track if pointerdown happens on a mesh
      raycasterRef.current.setFromCamera(mouseRef.current, camera);

      const meshes = getCachedMeshes();
      const intersects = raycasterRef.current.intersectObjects(meshes, true);
      // Consider a valid pointerdown when either on a mesh or over a valid snap indicator
      pointerDownOnMeshRef.current = intersects.length > 0 || Boolean(activeSnapPointRef.current);
    };

    const handlePointerUp = (event: MouseEvent): void => {
      // Handle right click - cancel current measurement only if no camera movement
      if (event.button === 2) {
        if (mouseIsDownRef.current) {
          const endQuat = camera.quaternion.clone();
          const endPos = camera.position.clone();
          const dot = Math.abs(startCameraQuatRef.current.dot(endQuat));
          const angle = 2 * Math.acos(Math.min(1, Math.max(-1, dot))); // Radians
          const rotated = angle > 0.01; // ~0.57°
          const translated = startCameraPosRef.current.distanceTo(endPos) > 1e-3;

          if (!rotated && !translated && currentStartRef.current) {
            // No camera movement: treat as explicit cancel
            graphicsActor.send({ type: 'cancelCurrentMeasurement' });
          }
        }

        pointerDownOnMeshRef.current = false;
        mouseIsDownRef.current = false;
        return;
      }

      // Only handle left clicks for measurement
      if (event.button !== 0) {
        return;
      }

      // If the camera rotated or translated while the mouse was held down, treat this as a view manipulation,
      // not a measurement click. This avoids registering a start/end point upon releasing the drag.
      if (mouseIsDownRef.current) {
        const endQuat = camera.quaternion.clone();
        const endPos = camera.position.clone();

        const dot = Math.abs(startCameraQuatRef.current.dot(endQuat));
        const angle = 2 * Math.acos(Math.min(1, Math.max(-1, dot))); // Radians
        const rotated = angle > 0.001; // ~0.057°

        const translated = startCameraPosRef.current.distanceTo(endPos) > 1e-3;

        if (rotated || translated) {
          pointerDownOnMeshRef.current = false;
          mouseIsDownRef.current = false;
          return;
        }
      }

      // Only process if interaction started on mesh OR we still have a valid snap indicator
      if (!pointerDownOnMeshRef.current && !activeSnapPointRef.current) {
        pointerDownOnMeshRef.current = false;
        return;
      }

      // Verify pointerup is also on a mesh by performing a fresh raycast
      raycasterRef.current.setFromCamera(mouseRef.current, camera);

      const meshes = getCachedMeshes();
      const intersects = raycasterRef.current.intersectObjects(meshes, true);
      if (intersects.length === 0 && !activeSnapPointRef.current) {
        // No intersection and no active snap target, ignore
        pointerDownOnMeshRef.current = false;
        return;
      }

      // Use snap point if available, otherwise use intersection point
      const point = activeSnapPointRef.current?.position ?? intersects[0]?.point;
      if (!point) {
        pointerDownOnMeshRef.current = false;
        return;
      }

      const pointArray: [number, number, number] = [point.x, point.y, point.z];

      if (currentStartRef.current) {
        // Disallow 0-length measurements by ignoring a completion click
        // that lands effectively on the start point (within a small epsilon)
        const startVec = new THREE.Vector3(...currentStartRef.current);
        const endVec = new THREE.Vector3(...pointArray);
        const zeroLengthEpsilon = 1e-4; // Scene units
        if (startVec.distanceTo(endVec) <= zeroLengthEpsilon) {
          pointerDownOnMeshRef.current = false;
          mouseIsDownRef.current = false;
          return;
        }

        graphicsActor.send({
          type: 'completeMeasurement',
          payload: pointArray,
        });
      } else {
        graphicsActor.send({ type: 'startMeasurement', payload: pointArray });
      }

      // Reset the pointerdown flag
      pointerDownOnMeshRef.current = false;
      mouseIsDownRef.current = false;
    };

    const handleContextMenu = (event: MouseEvent): void => {
      // Prevent context menu from showing during measurement
      event.preventDefault();
    };

    gl.domElement.addEventListener('mousemove', handleMouseMove);
    gl.domElement.addEventListener('pointerdown', handlePointerDown);
    gl.domElement.addEventListener('pointerup', handlePointerUp);
    gl.domElement.addEventListener('contextmenu', handleContextMenu);

    return () => {
      gl.domElement.removeEventListener('mousemove', handleMouseMove);
      gl.domElement.removeEventListener('pointerdown', handlePointerDown);
      gl.domElement.removeEventListener('pointerup', handlePointerUp);
      gl.domElement.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [camera, gl, scene, snapDistance, isMeasureActive, graphicsActor, getCachedMeshes]);

  // Choose which measurements to display: all during measure mode, otherwise only pinned
  const visibleMeasurements = isMeasureActive ? measurements : measurements.filter((m) => m.isPinned);

  // Memoize currentStart Vector3 to avoid per-render allocation
  const currentStartVec3 = useMemo(
    () => (currentStart ? new THREE.Vector3(...currentStart) : undefined),
    [currentStart],
  );

  return (
    <group>
      {/* Render snap point indicators */}
      {isMeasureActive
        ? hoveredSnapPoints.map((snapPoint) => {
            const key = `snap-${snapPoint.position.x}-${snapPoint.position.y}-${snapPoint.position.z}`;
            return (
              <SnapPointIndicator
                key={key}
                position={snapPoint.position}
                isActive={snapPoint === activeSnapPoint}
                camera={camera}
              />
            );
          })
        : null}

      {/* Persistent indicator for the selected start point */}
      {isMeasureActive && currentStartVec3 ? (
        <SnapPointIndicator isActive position={currentStartVec3} camera={camera} />
      ) : null}

      {/* Render preview line */}
      {isMeasureActive && currentStartVec3 && mousePosition ? (
        <MeasurementLine isPreview start={currentStartVec3} end={mousePosition} />
      ) : null}

      {/* Render completed measurements */}
      {visibleMeasurements.map((measurement) => (
        <MeasurementLine
          key={measurement.id}
          id={measurement.id}
          start={measurement.startPoint}
          end={measurement.endPoint}
          distance={measurement.distance}
          lengthFactor={lengthFactor}
          lengthSymbol={lengthSymbol}
          isExternallyHovered={hoveredMeasurementId === measurement.id}
          isPinned={Boolean(measurement.isPinned)}
        />
      ))}
    </group>
  );
}

type SnapPointIndicatorProps = {
  readonly position: THREE.Vector3;
  // Indicates hovered/selected state for color
  readonly isActive: boolean;
  readonly camera: THREE.Camera;
};

function SnapPointIndicator({ position, isActive, camera }: SnapPointIndicatorProps): React.JSX.Element {
  const outerRef = useRef<THREE.Mesh>(null);
  const innerRef = useRef<THREE.Mesh>(null);

  const borderSize = isActive ? 0.05 : 0.04;
  const innerSize = isActive ? 0.04 : 0.03;
  const height = 0.05;
  const segments = 32;

  useFrame(() => {
    const scale = calculateScaleFromCamera(position, camera);

    // Face camera -- reuse module-scope scratch objects
    _snapDirection.subVectors(camera.position, position).normalize();
    _snapQuaternion.setFromUnitVectors(_snapUp.set(0, 1, 0), _snapDirection);

    if (outerRef.current) {
      outerRef.current.quaternion.copy(_snapQuaternion);
      outerRef.current.scale.set(scale * 500, scale * 500, scale * 500);
    }

    if (innerRef.current) {
      innerRef.current.quaternion.copy(_snapQuaternion);
      innerRef.current.scale.set(scale * 500, scale * 500, scale * 500);
    }
  });

  return (
    <group renderOrder={isActive ? 10 : 0}>
      {/* Outer border (black) */}
      <mesh
        ref={outerRef}
        position={position}
        renderOrder={isActive ? 2 : 1}
        userData={sceneTagData(sceneTag.measurementUi)}
      >
        <cylinderGeometry args={[borderSize, borderSize, height, segments]} />
        <meshMatcapMaterial
          transparent
          // oxlint-disable-next-line tau-lint/no-hardcoded-color -- Three.js material color
          color='#000000'
          opacity={1}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      {/* Inner fill (white or green when active/hovered/selected) */}
      <mesh
        ref={innerRef}
        position={position}
        // Ensure the hover/selected indicator is rendered on top of other indicators
        renderOrder={isActive ? 2 : 1}
        userData={sceneTagData(sceneTag.measurementUi)}
      >
        <cylinderGeometry args={[innerSize, innerSize, height, segments]} />
        <meshBasicMaterial
          transparent
          toneMapped={false}
          fog={false}
          // oxlint-disable-next-line tau-lint/no-hardcoded-color -- Three.js material color
          color={isActive ? '#00ff00' : '#ffffff'}
          opacity={1}
          depthTest={false}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}

type MeasurementLineProps = {
  readonly id?: string;
  readonly start: THREE.Vector3 | readonly [number, number, number];
  readonly end: THREE.Vector3 | readonly [number, number, number];
  readonly distance?: number;
  readonly lengthFactor?: number;
  readonly lengthSymbol?: string;
  readonly isPreview?: boolean;
  readonly isExternallyHovered?: boolean;
  readonly isPinned?: boolean;
  readonly coneHeight?: number; // Base cone height in scene units
  readonly coneRadius?: number; // Base cone radius in scene units
  readonly cylinderRadius?: number; // Base cylinder radius in scene units
  // Text sizing
  readonly textSize?: number;
  readonly textDepth?: number;
  // Label/background sizing
  readonly labelHeight?: number;
  readonly labelPadding?: number;
  readonly labelCornerRadius?: number;
  readonly labelDepth?: number;
  readonly labelCharWidth?: number;
  // Formatting and behavior
  readonly decimals?: number;
  readonly enableUnits?: boolean;
  readonly materials?:
    | {
        readonly backgroundMaterial: THREE.Material;
        readonly textMaterial: THREE.Material;
        readonly coneMaterial: THREE.Material;
      }
    | {
        readonly backgroundColor: THREE.Color;
        readonly textColor: THREE.Color;
        readonly coneColor: THREE.Color;
      };
};

function MeasurementLine({
  id,
  start,
  end,
  distance,
  lengthFactor = 1,
  lengthSymbol = 'mm',
  isPreview = false,
  isExternallyHovered = false,
  isPinned = false,
  coneHeight = 80,
  coneRadius = 10,
  cylinderRadius = 2,
  textSize = 40,
  textDepth = 2,
  labelHeight = 80,
  labelPadding = 50,
  labelCornerRadius = 20,
  labelDepth = 1,
  labelCharWidth = 24,
  decimals = 1,
  enableUnits = true,
  materials,
}: MeasurementLineProps): React.JSX.Element {
  const { camera } = useThree();

  // Memoize Vector3 conversion so tuples from state don't allocate per render
  const startVec = useMemo(() => (start instanceof THREE.Vector3 ? start : new THREE.Vector3(...start)), [start]);
  const endVec = useMemo(() => (end instanceof THREE.Vector3 ? end : new THREE.Vector3(...end)), [end]);

  const labelGroupRef = useRef<THREE.Group>(null);
  const lineGroupRef = useRef<THREE.Group>(null);
  const cylinderMeshRef = useRef<THREE.Mesh>(null);
  const startConeMeshRef = useRef<THREE.Mesh>(null);
  const endConeMeshRef = useRef<THREE.Mesh>(null);
  const [isLabelHovered, setIsLabelHovered] = useState(false);
  const isHovered = isLabelHovered || isExternallyHovered;
  const graphicsActor = useGraphics();

  // Create matcap materials following transform-controls pattern.
  // Split into base materials (created once) and hover color update (cheap, per-hover).
  const derivedMaterials = useMemo(() => {
    if (materials && 'backgroundMaterial' in materials && 'textMaterial' in materials && 'coneMaterial' in materials) {
      return {
        backgroundMaterial: materials.backgroundMaterial,
        textMaterial: materials.textMaterial,
        coneMaterial: materials.coneMaterial,
      };
    }

    const matcapTexture = matcapMaterial();

    const baseMaterial = new THREE.MeshMatcapMaterial({
      matcap: matcapTexture,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });
    const basicMaterial = new THREE.MeshBasicMaterial({
      color: materials?.backgroundColor ?? 0xff_ff_ff, // White
      depthTest: false,
      depthWrite: false,
      transparent: true,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
    });

    const backgroundMaterial = basicMaterial.clone();
    backgroundMaterial.color.set(materials?.backgroundColor ?? 0xff_ff_ff); // White

    const textMaterial = baseMaterial.clone();
    textMaterial.color.set(materials?.textColor ?? 0x00_00_00); // Black

    const coneMaterial = baseMaterial.clone();
    coneMaterial.color.set(materials?.coneColor ?? 0x00_00_00);

    return { backgroundMaterial, textMaterial, coneMaterial };
  }, [materials]);

  // Memoize pin button matcap texture to avoid per-render texture creation
  const pinMatcapTexture = useMemo(() => matcapMaterial(), []);

  // Update cone color on hover without recreating all materials
  useEffect(() => {
    if (materials && 'coneMaterial' in materials) {
      return; // Externally provided materials manage their own color
    }

    const coneColor = isHovered ? 0x00_ff_00 : materials && 'coneColor' in materials ? materials.coneColor : 0x00_00_00;
    (derivedMaterials.coneMaterial as THREE.MeshMatcapMaterial).color.set(coneColor);
  }, [isHovered, derivedMaterials, materials]);

  // Calculate label position (midpoint)
  const midpoint = useMemo(
    () => new THREE.Vector3().addVectors(startVec, endVec).multiplyScalar(0.5),
    [startVec, endVec],
  );

  // Calculate distance if not provided
  const calculatedDistance = distance ?? startVec.distanceTo(endVec);
  const distanceInMm = calculatedDistance / lengthFactor;
  const numericText = distanceInMm.toFixed(decimals);
  const unitsText = enableUnits ? lengthSymbol : '';
  const labelText = `${numericText}${enableUnits ? ` ${unitsText}` : ''}`;

  // Keep a constant width box reserved for the units portion of the label background
  const unitContainerChars = 3; // Reserve width for up to 3-char units
  const backgroundCharsLength = numericText.length + (enableUnits ? 1 + unitContainerChars : 0);
  const backgroundPlaceholderText = '0'.repeat(Math.max(1, backgroundCharsLength));

  // Memoize geometries to avoid re-creating large buffers every render frame
  const textGeometry = useMemo(
    // oxlint-disable-next-line new-cap -- Three.js convention
    () => LabelTextGeometry({ text: labelText, size: textSize, depth: textDepth }),
    [labelText, textSize, textDepth],
  );

  const backgroundGeometry = useMemo(
    () =>
      // oxlint-disable-next-line new-cap -- Three.js convention
      LabelBackgroundGeometry({
        // Use placeholder string sized to reserve constant-width units area
        text: backgroundPlaceholderText,
        characterWidth: labelCharWidth,
        padding: labelPadding,
        height: labelHeight,
        radius: labelCornerRadius,
        depth: labelDepth,
      }),
    [backgroundPlaceholderText, labelCharWidth, labelPadding, labelHeight, labelCornerRadius, labelDepth],
  );

  const backgroundOutlineGeometry = useMemo(
    () =>
      // oxlint-disable-next-line new-cap -- Three.js convention
      LabelBackgroundGeometry({
        text: backgroundPlaceholderText,
        characterWidth: labelCharWidth,
        padding: labelPadding + 5,
        height: labelHeight + 10,
        radius: labelCornerRadius + 5,
        depth: labelDepth,
      }),
    [backgroundPlaceholderText, labelCharWidth, labelPadding, labelHeight, labelCornerRadius, labelDepth],
  );

  // Track current scale for UI sizing
  const scaleRef = useRef<number>(1);

  // Memoize measurement line direction and quaternions to avoid per-render allocations
  const lineDirection = useMemo(() => new THREE.Vector3().subVectors(endVec, startVec).normalize(), [startVec, endVec]);

  // Billboard behavior - rotate around line axis to face camera
  // All scratch objects are module-scoped to avoid per-frame GC pressure.
  useFrame(() => {
    const scale = calculateScaleFromCamera(midpoint, camera);
    scaleRef.current = scale;

    // Scale and orient label group
    if (labelGroupRef.current) {
      // 1) Establish base orientation: align X-axis with the measurement line
      _baseQuat.setFromUnitVectors(_currentNormal.set(1, 0, 0), lineDirection);

      // 2) Compute rotation around the line axis so the label's normal faces the camera
      _currentNormal.set(0, 0, 1).applyQuaternion(_baseQuat);
      const axisRotation = computeAxisRotationForCamera({
        axis: lineDirection,
        position: midpoint,
        camera,
        referenceUp: _currentNormal,
      });

      // 3) Combine rotations: base alignment then axis rotation in world space
      _finalQuat.multiplyQuaternions(axisRotation, _baseQuat);

      // 4) Ensure text is upright relative to the camera
      _labelNormal.set(0, 0, 1).applyQuaternion(_finalQuat).normalize();
      _labelUp.set(0, 1, 0).applyQuaternion(_finalQuat).normalize();

      _cameraUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();
      _cameraUpProjected.copy(_cameraUp).addScaledVector(_labelNormal, -_cameraUp.dot(_labelNormal)).normalize();

      if (_labelUp.dot(_cameraUpProjected) < 0) {
        // Flip around the label's normal so it stays facing the camera
        _flipQuat.setFromAxisAngle(_labelNormal, Math.PI);
        _finalQuat.copy(_axisRotation.multiplyQuaternions(_flipQuat, _finalQuat));
      }

      labelGroupRef.current.quaternion.copy(_finalQuat);
      // Enlarge label by 20% when hovered (from UI or viewport)
      labelGroupRef.current.scale.setScalar(scale * (isHovered ? 1.2 : 1));
      labelGroupRef.current.position.copy(midpoint);
    }

    // Dynamically size cylinder and cones using transform scaling with unit geometries
    _lineDir.subVectors(endVec, startVec).normalize();

    // Derive UI dimensions from scale using component props
    const coneHeightScaled = coneHeight * scale; // Height of arrow heads
    const coneRadiusScaled = coneRadius * scale; // Radius of arrow heads
    const cylinderRadiusScaled = cylinderRadius * scale; // Thickness of the line

    const effectiveCone = isPreview ? 0 : coneHeightScaled;
    const cylinderHeight = Math.max(0.0001, lineDistance - 2 * effectiveCone);

    if (cylinderMeshRef.current) {
      cylinderMeshRef.current.scale.set(cylinderRadiusScaled, cylinderHeight, cylinderRadiusScaled);
    }

    _coneOffset.copy(_lineDir).multiplyScalar(coneHeightScaled / 2);
    if (startConeMeshRef.current) {
      startConeMeshRef.current.scale.set(coneRadiusScaled, coneHeightScaled, coneRadiusScaled);
      startConeMeshRef.current.position.copy(startVec).add(_coneOffset);
    }

    if (endConeMeshRef.current) {
      endConeMeshRef.current.scale.set(coneRadiusScaled, coneHeightScaled, coneRadiusScaled);
      endConeMeshRef.current.position.copy(endVec).sub(_coneOffset);
    }
  });

  // Memoize direction, distance, and quaternions for cylinder/cone rotation
  const lineDistance = useMemo(() => startVec.distanceTo(endVec), [startVec, endVec]);
  const { startQuaternion, endQuaternion, cylinderQuaternion } = useMemo(() => {
    const up = new THREE.Vector3(0, 1, 0);
    const startQ = new THREE.Quaternion().setFromUnitVectors(up, lineDirection.clone().negate());
    const endQ = new THREE.Quaternion().setFromUnitVectors(up, lineDirection);
    const cylinderQ = new THREE.Quaternion().setFromUnitVectors(up, lineDirection);
    return {
      startQuaternion: startQ,
      endQuaternion: endQ,
      cylinderQuaternion: cylinderQ,
    };
  }, [lineDirection]);

  return (
    <group>
      {/* Line group with scaling for cylinders and cones */}
      <group ref={lineGroupRef} renderOrder={1}>
        {/* Cylinder line */}
        <mesh
          ref={cylinderMeshRef}
          position={midpoint}
          quaternion={cylinderQuaternion}
          userData={sceneTagData(sceneTag.measurementUi)}
        >
          {/* Unit geometry – scaled per-frame */}
          <cylinderGeometry args={[1, 1, 1, 16]} />
          <primitive object={derivedMaterials.coneMaterial} attach='material' />
        </mesh>

        {/* Cone at start */}
        {!isPreview && (
          <mesh
            ref={startConeMeshRef}
            position={start}
            quaternion={startQuaternion}
            userData={sceneTagData(sceneTag.measurementUi)}
          >
            {/* Unit geometry – scaled per-frame */}
            <coneGeometry args={[1, 1, 16]} />
            <primitive object={derivedMaterials.coneMaterial} attach='material' />
          </mesh>
        )}

        {/* Cone at end */}
        {!isPreview && (
          <mesh
            ref={endConeMeshRef}
            position={end}
            quaternion={endQuaternion}
            userData={sceneTagData(sceneTag.measurementUi)}
          >
            {/* Unit geometry – scaled per-frame */}
            <coneGeometry args={[1, 1, 16]} />
            <primitive object={derivedMaterials.coneMaterial} attach='material' />
          </mesh>
        )}
      </group>

      {/* Label */}
      {!isPreview && (
        <group ref={labelGroupRef} renderOrder={2} position={midpoint} rotation={[0, 0, 0]}>
          {/* Stable invisible hit area to prevent hover flicker when pin appears */}
          <mesh
            position={[0, 0, 0]}
            userData={sceneTagData(sceneTag.measurementUi)}
            onPointerEnter={(event) => {
              event.stopPropagation();
              setIsLabelHovered(true);
              if (id) {
                graphicsActor.send({
                  type: 'setHoveredMeasurement',
                  payload: id,
                });
              }
            }}
            onPointerLeave={(event) => {
              event.stopPropagation();
              setIsLabelHovered(false);
              graphicsActor.send({
                type: 'setHoveredMeasurement',
                payload: undefined,
              });
            }}
          >
            {(() => {
              const totalChars = backgroundPlaceholderText.length;
              const baseWidth = totalChars * labelCharWidth + 2 * labelPadding;
              const buttonDiameter = 2 * labelCharWidth;
              const hitWidth = baseWidth + buttonDiameter + Math.max(5, labelPadding * 0.2);
              const hitHeight = labelHeight + 2 * labelPadding;
              return (
                <>
                  <planeGeometry args={[hitWidth, hitHeight]} />
                  <meshBasicMaterial
                    transparent
                    opacity={0}
                    depthTest={false}
                    depthWrite={false}
                    side={THREE.DoubleSide}
                  />
                </>
              );
            })()}
          </mesh>
          {/* Background */}
          <mesh position={[0, 0, 0]} userData={sceneTagData(sceneTag.measurementUi)}>
            <primitive object={backgroundOutlineGeometry} attach='geometry' />
            <primitive object={derivedMaterials.textMaterial} attach='material' />
          </mesh>
          <mesh position={[0, 0, 0]} userData={sceneTagData(sceneTag.measurementUi)}>
            <primitive object={backgroundGeometry} attach='geometry' />
            <primitive object={derivedMaterials.backgroundMaterial} attach='material' />
          </mesh>

          {/* Text */}
          <mesh position={[0, 0, 0]} userData={sceneTagData(sceneTag.measurementUi)}>
            <primitive object={textGeometry} attach='geometry' />
            <primitive object={derivedMaterials.textMaterial} attach='material' />
          </mesh>

          {/* Pin button in top-right over label */}
          {id && isHovered ? (
            <group
              position={(() => {
                // Compute approximate background width from placeholder and char width/padding
                const totalChars = backgroundPlaceholderText.length;
                const width = totalChars * labelCharWidth + 2 * labelPadding;
                const buttonDiameter = 2 * labelCharWidth; // 2 characters width
                const offsetX = width / 2 - buttonDiameter / 2 - Math.max(5, labelPadding * 0.2);
                const offsetY = 0; // Vertically centered
                return [offsetX, offsetY, 0];
              })()}
              renderOrder={3}
              userData={sceneTagData(sceneTag.measurementUi)}
            >
              {/* Yellow/gold circular pin button (appears only on label hover) */}
              <mesh
                userData={sceneTagData(sceneTag.measurementUi)}
                onPointerOver={(event) => {
                  event.stopPropagation();
                  // Keep hover state active when over pin button
                  setIsLabelHovered(true);
                  if (id) {
                    graphicsActor.send({
                      type: 'setHoveredMeasurement',
                      payload: id,
                    });
                  }
                }}
                onPointerOut={(event) => {
                  event.stopPropagation();
                  // Don't clear hover immediately - let the label group handle it
                }}
                onPointerDown={(event) => {
                  if (event.nativeEvent.button === 0 && id) {
                    graphicsActor.send({ type: 'toggleMeasurementPinned', id });
                  }

                  event.stopPropagation();
                }}
              >
                <circleGeometry args={[labelCharWidth, 48]} />
                <meshMatcapMaterial
                  color={isPinned ? 0xff_d7_00 : 0xff_ff_99}
                  opacity={1}
                  depthTest={false}
                  depthWrite={false}
                  side={THREE.DoubleSide}
                  fog={false}
                  toneMapped={false}
                  matcap={pinMatcapTexture}
                  transparent={false}
                />
              </mesh>

              {/* Pin glyph using simple geometry */}
              <mesh
                position={[0, labelCharWidth * 0.15, 0]}
                userData={sceneTagData(sceneTag.measurementUi)}
                onPointerOver={(event) => {
                  event.stopPropagation();
                }}
                onPointerOut={(event) => {
                  event.stopPropagation();
                }}
              >
                <cylinderGeometry args={[labelCharWidth * 0.12, labelCharWidth * 0.12, labelCharWidth * 0.4, 16]} />
                <primitive object={derivedMaterials.textMaterial} attach='material' />
              </mesh>
              <mesh
                position={[0, -labelCharWidth * 0.2, 0]}
                userData={sceneTagData(sceneTag.measurementUi)}
                onPointerOver={(event) => {
                  event.stopPropagation();
                }}
                onPointerOut={(event) => {
                  event.stopPropagation();
                }}
              >
                <coneGeometry args={[labelCharWidth * 0.15, labelCharWidth * 0.35, 16]} />
                <primitive object={derivedMaterials.textMaterial} attach='material' />
              </mesh>
            </group>
          ) : null}
        </group>
      )}
    </group>
  );
}
