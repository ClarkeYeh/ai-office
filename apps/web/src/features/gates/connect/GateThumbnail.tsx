import type { OfficeViewModel } from '../../office/index.js';
import { OfficeScene, useOfficeViewModel } from '../../office/index.js';
import { t } from '../../../shared/lib/i18n/index.js';

/** The thumbnail's integer scale: plates stay readable, pixels stay crisp. */
export const THUMBNAIL_SCALE = 2;
/** The fixed viewport, in world pixels: the wall and the top row of rooms. */
export const THUMBNAIL_CROP = { w: 256, h: 128 } as const;

/**
 * The world-pixel origin of the crop: centred on your office (the lamp, the
 * '!' and the door to main), clamped to the floor so no void shows. With the
 * office in the floor's corner the clamp also keeps its neighbours in view.
 */
export function thumbnailCrop(vm: OfficeViewModel): { x: number; y: number } {
  const yours = vm.rooms.find((room) => room.id === 'yours')?.rect;
  const cx = yours ? yours.x + yours.w / 2 : vm.world.width / 2;
  const cy = yours ? yours.y + yours.h / 2 : vm.world.height / 2;
  const clamp = (v: number, max: number) =>
    Math.round(Math.min(Math.max(0, max), Math.max(0, v)));
  return {
    x: clamp(cx - THUMBNAIL_CROP.w / 2, vm.world.width - THUMBNAIL_CROP.w),
    y: clamp(cy - THUMBNAIL_CROP.h / 2, vm.world.height - THUMBNAIL_CROP.h),
  };
}

/**
 * V3Gate's quiet office: the real scene at an integer 2×, cropped (never
 * resampled) to a fixed viewport around your office, still and hidden from
 * assistive tech; `GateLayout` gives the slot its text alternative. Only the
 * gate's own workflow is drawn.
 */
export function GateThumbnail({ workflowId }: { workflowId: string }) {
  const vm = useOfficeViewModel();
  if (!vm || vm.workflowId !== workflowId) return null;
  const s = THUMBNAIL_SCALE;
  const crop = thumbnailCrop(vm);
  return (
    <div
      data-testid="gate-thumbnail-crop"
      data-crop={`${crop.x},${crop.y}`}
      style={{
        position: 'relative',
        flex: 'none',
        width: THUMBNAIL_CROP.w * s,
        height: THUMBNAIL_CROP.h * s,
        overflow: 'hidden',
      }}
    >
      <div
        style={{ position: 'absolute', left: -crop.x * s, top: -crop.y * s }}
      >
        <OfficeScene vm={vm} t={t} scale={s} interactive={false} />
      </div>
    </div>
  );
}
