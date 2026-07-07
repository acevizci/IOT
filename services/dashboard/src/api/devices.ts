import { apiFetch } from "./client";

export interface Device {
  id: string;
  name: string;
  ip_address: string;
  device_type: string;
  vendor: string | null;
  location: string | null;
  status: string;
  created_at: string;
}

export interface DeviceListParams {
  page?: number;
  limit?: number;
  status?: string;
  device_type?: string;
  search?: string;
}

export function fetchDevices(params: DeviceListParams = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set("page", String(params.page));
  if (params.limit) query.set("limit", String(params.limit));
  if (params.status) query.set("status", params.status);
  if (params.device_type) query.set("device_type", params.device_type);
  if (params.search) query.set("search", params.search);

  const qs = query.toString();
  return apiFetch<Device[]>(`/api/v1/devices${qs ? `?${qs}` : ""}`);
}
