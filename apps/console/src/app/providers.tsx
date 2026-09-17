import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

import { queryClient } from "../lib/query/queryClient";

export interface ProvidersProps {
  children: React.ReactNode;
}

export const Providers: React.FC<ProvidersProps> = ({ children }) => {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
};
