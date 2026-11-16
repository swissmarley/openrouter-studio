"use client";

import { useEffect, useState } from "react";
import type { ModelInfo } from "@/lib/shared/models";
import { api } from "./api";

interface ModelsState {
  models: ModelInfo[];
  loading: boolean;
  error: string | null;
}

// One catalog fetch shared by every screen in the tab (explorer, pickers, cost estimates).
let cached: ModelInfo[] | null = null;
let inflight: Promise<ModelInfo[]> | null = null;
const listeners = new Set<(models: ModelInfo[]) => void>();

async function load(refresh = false): Promise<ModelInfo[]> {
  if (!refresh && cached) return cached;
  if (!refresh && inflight) return inflight;
  inflight = api
    .get<{ models: ModelInfo[] }>(`/api/models${refresh ? "?refresh=1" : ""}`)
    .then((res) => {
      cached = res.models;
      listeners.forEach((fn) => fn(res.models));
      return res.models;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useModels(): ModelsState & { refresh: () => Promise<void> } {
  const [state, setState] = useState<ModelsState>({ models: cached ?? [], loading: !cached, error: null });

  useEffect(() => {
    const onUpdate = (models: ModelInfo[]) => setState({ models, loading: false, error: null });
    listeners.add(onUpdate);
    load().then(onUpdate, (err: Error) => setState({ models: [], loading: false, error: err.message }));
    return () => {
      listeners.delete(onUpdate);
    };
  }, []);

  return {
    ...state,
    refresh: async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        await load(true);
      } catch (err) {
        setState((s) => ({ ...s, loading: false, error: (err as Error).message }));
      }
    },
  };
}
