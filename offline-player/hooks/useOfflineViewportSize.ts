import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { useCanvasStore } from '@/lib/store/canvas';

export interface ViewportStyles {
  width: number;
  height: number;
  left: number;
  top: number;
}

export function useOfflineViewportSize(canvasRef: RefObject<HTMLElement | null>) {
  const [viewportLeft, setViewportLeft] = useState(0);
  const [viewportTop, setViewportTop] = useState(0);
  const canvasPercentage = useCanvasStore.use.canvasPercentage();
  const canvasDragged = useCanvasStore.use.canvasDragged();
  const setCanvasScale = useCanvasStore.use.setCanvasScale();
  const setCanvasDragged = useCanvasStore.use.setCanvasDragged();
  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();

  const initViewportPosition = useCallback(() => {
    if (!canvasRef.current) return;
    const canvasWidth = canvasRef.current.clientWidth;
    const canvasHeight = canvasRef.current.clientHeight;

    if (canvasHeight / canvasWidth > viewportRatio) {
      const viewportActualWidth = canvasWidth * (canvasPercentage / 100);
      setCanvasScale(viewportActualWidth / viewportSize);
      setViewportLeft((canvasWidth - viewportActualWidth) / 2);
      setViewportTop((canvasHeight - viewportActualWidth * viewportRatio) / 2);
    } else {
      const viewportActualHeight = canvasHeight * (canvasPercentage / 100);
      setCanvasScale(viewportActualHeight / (viewportSize * viewportRatio));
      setViewportLeft((canvasWidth - viewportActualHeight / viewportRatio) / 2);
      setViewportTop((canvasHeight - viewportActualHeight) / 2);
    }
  }, [canvasRef, canvasPercentage, viewportRatio, viewportSize, setCanvasScale]);

  const setViewportPosition = useCallback(
    (newValue: number, oldValue: number) => {
      if (!canvasRef.current) return;
      const canvasWidth = canvasRef.current.clientWidth;
      const canvasHeight = canvasRef.current.clientHeight;

      if (canvasHeight / canvasWidth > viewportRatio) {
        const newViewportActualWidth = canvasWidth * (newValue / 100);
        const oldViewportActualWidth = canvasWidth * (oldValue / 100);
        const newViewportActualHeight = newViewportActualWidth * viewportRatio;
        const oldViewportActualHeight = oldViewportActualWidth * viewportRatio;
        setCanvasScale(newViewportActualWidth / viewportSize);
        setViewportLeft((prev) => prev - (newViewportActualWidth - oldViewportActualWidth) / 2);
        setViewportTop((prev) => prev - (newViewportActualHeight - oldViewportActualHeight) / 2);
      } else {
        const newViewportActualHeight = canvasHeight * (newValue / 100);
        const oldViewportActualHeight = canvasHeight * (oldValue / 100);
        const newViewportActualWidth = newViewportActualHeight / viewportRatio;
        const oldViewportActualWidth = oldViewportActualHeight / viewportRatio;
        setCanvasScale(newViewportActualHeight / (viewportSize * viewportRatio));
        setViewportLeft((prev) => prev - (newViewportActualWidth - oldViewportActualWidth) / 2);
        setViewportTop((prev) => prev - (newViewportActualHeight - oldViewportActualHeight) / 2);
      }
    },
    [canvasRef, viewportRatio, viewportSize, setCanvasScale],
  );

  const prevCanvasPercentageRef = useRef(canvasPercentage);

  useEffect(() => {
    if (prevCanvasPercentageRef.current !== canvasPercentage) {
      setViewportPosition(canvasPercentage, prevCanvasPercentageRef.current);
      prevCanvasPercentageRef.current = canvasPercentage;
    }
  }, [canvasPercentage, setViewportPosition]);

  useEffect(() => {
    initViewportPosition();
  }, [viewportRatio, viewportSize, initViewportPosition]);

  useEffect(() => {
    if (!canvasDragged) initViewportPosition();
  }, [canvasDragged, initViewportPosition]);

  useEffect(() => {
    const el = canvasRef.current;
    const resizeObserver = new ResizeObserver(initViewportPosition);
    if (el) resizeObserver.observe(el);
    return () => {
      if (el) resizeObserver.unobserve(el);
    };
  }, [canvasRef, initViewportPosition]);

  const dragViewport = useCallback(
    (e: ReactMouseEvent) => {
      let isMouseDown = true;
      const startPageX = e.pageX;
      const startPageY = e.pageY;
      const originLeft = viewportLeft;
      const originTop = viewportTop;

      const handleMouseMove = (event: MouseEvent) => {
        if (!isMouseDown) return;
        setViewportLeft(originLeft + (event.pageX - startPageX));
        setViewportTop(originTop + (event.pageY - startPageY));
      };

      const handleMouseUp = () => {
        isMouseDown = false;
        document.onmousemove = null;
        document.onmouseup = null;
        setCanvasDragged(true);
      };

      document.onmousemove = handleMouseMove;
      document.onmouseup = handleMouseUp;
    },
    [viewportLeft, viewportTop, setCanvasDragged],
  );

  const viewportStyles: ViewportStyles = useMemo(
    () => ({
      width: viewportSize,
      height: viewportSize * viewportRatio,
      left: viewportLeft,
      top: viewportTop,
    }),
    [viewportSize, viewportRatio, viewportLeft, viewportTop],
  );

  return { viewportStyles, dragViewport };
}
