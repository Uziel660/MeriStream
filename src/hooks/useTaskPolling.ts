// src/hooks/useTaskPolling.ts
// Hace polling a GET /api/v1/tasks/{id} mientras la tarea siga en pending/running.

import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import type { TaskOut } from "../types";

const ACTIVE_STATES = new Set(["pending", "running"]);
const POLL_INTERVAL_MS = 1800;

export function useTaskPolling(taskId: string | null) {
  const [task, setTask] = useState<TaskOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setError(null);
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const result = await api.getTask(taskId);
        if (cancelled) return;
        setTask(result);
        setError(null);
        if (!ACTIVE_STATES.has(result.status) && intervalRef.current) {
          window.clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "No se pudo obtener el estado de la tarea.");
      }
    };

    poll(); // primera lectura inmediata
    intervalRef.current = window.setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [taskId]);

  return { task, error };
}
