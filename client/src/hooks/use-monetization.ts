import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type MonetizationItem } from "@shared/routes";

export function useMonetizationItems() {
  return useQuery({
    queryKey: [api.monetization.list.path],
    queryFn: async () => {
      const res = await fetch(api.monetization.list.path, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch monetization items");
      return api.monetization.list.responses[200].parse(await res.json());
    },
  });
}

// Mostly for testing/seeding via UI if needed
export function useCreateMonetizationItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { title: string; status: string; thumbnailUrl?: string }) => {
      const res = await fetch(api.monetization.create.path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to create item");
      return api.monetization.create.responses[201].parse(await res.json());
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [api.monetization.list.path] });
    },
  });
}
