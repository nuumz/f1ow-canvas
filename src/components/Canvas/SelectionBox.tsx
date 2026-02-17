import React from 'react';
import { Rect } from 'react-konva';

interface Props {
    box: { x: number; y: number; width: number; height: number } | null;
    selectionColor?: string;
}

const SelectionBox: React.FC<Props> = ({ box, selectionColor = '#4f8df7' }) => {
    if (!box) return null;

    return (
        <Rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill={`${selectionColor}14`}
            stroke={selectionColor}
            strokeWidth={1}
            dash={[4, 4]}
            listening={false}
        />
    );
};

export default React.memo(SelectionBox);
