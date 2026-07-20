import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchSyslogPatterns,
  createSyslogPattern,
  updateSyslogPattern,
  deleteSyslogPattern,
  type SyslogPatternInput
} from "../../api/syslogPatterns";

export function useSyslogPatterns() {
  return useQuery({ queryKey: ["syslog-patterns"], queryFn: fetchSyslogPatterns });
}

export function useCreateSyslogPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createSyslogPattern,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["syslog-patterns"] })
  });
}

export function useUpdateSyslogPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: SyslogPatternInput }) => updateSyslogPattern(id, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["syslog-patterns"] })
  });
}

export function useDeleteSyslogPattern() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteSyslogPattern,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["syslog-patterns"] })
  });
}
