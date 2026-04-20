/**
 * useFlowAnimation.ts — Animates dashOffset on a Konva shape to create
 * a "flowing" line effect, useful for architecture diagrams to show
 * data flow direction.
 *
 * Uses Konva.Animation for GPU-efficient, non-blocking animation.
 */
import { useEffect, useRef } from 'react';
import Konva from 'konva';

/** Speed of the flow animation in pixels per second */
const FLOW_SPEED = 40;

/**
 * Animate dashOffset on a Konva node to create a "flowing" dash effect.
 * @param nodeRef - React ref to a Konva Line or Shape node
 * @param enabled - whether animation is active
 * @param speed - pixels per second (default 40)
 */
export function useFlowAnimation(
    nodeRef: React.RefObject<Konva.Line | Konva.Shape | null>,
    enabled: boolean,
    speed = FLOW_SPEED,
): void {
    const animRef = useRef<Konva.Animation | null>(null);

    useEffect(() => {
        if (!enabled || !nodeRef.current) {
            if (animRef.current) {
                animRef.current.stop();
                animRef.current = null;
            }
            return;
        }

        const node = nodeRef.current;
        const layer = node.getLayer();
        if (!layer) return;

        const anim = new Konva.Animation((frame) => {
            if (!frame) return;
            const offset = (frame.time / 1000) * speed;
            node.dashOffset(-offset);
        }, layer);

        animRef.current = anim;
        anim.start();

        return () => {
            anim.stop();
            animRef.current = null;
        };
    }, [enabled, nodeRef, speed]);
}
