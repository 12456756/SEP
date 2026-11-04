'use client';

import { useEffect, useState } from 'react';
import { fetchClientRelease, type ClientRelease } from './client-releases';

type ClientReleaseState = {
  release: ClientRelease | null;
  loading: boolean;
};

export function useClientRelease(): ClientReleaseState {
  const [state, setState] = useState<ClientReleaseState>({
    release: null,
    loading: true,
  });

  useEffect(() => {
    let active = true;

    void fetchClientRelease()
      .then((release) => {
        if (active) setState({ release, loading: false });
      })
      .catch(() => {
        if (active) setState({ release: null, loading: false });
      });

    return () => {
      active = false;
    };
  }, []);

  return state;
}
