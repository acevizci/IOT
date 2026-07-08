import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TopologyNode, ManualLink, TrafficEdge } from "../../api/topology";

interface Props {
  nodes: TopologyNode[];
  manualLinks: ManualLink[];
  trafficEdges: TrafficEdge[];
}

const DEVICE_TYPE_COLOR: Record<string, string> = {
  switch: "#185fa5",
  firewall: "#a32d2d",
  router: "#854f0b",
  server: "#0f6e56",
  load_balancer: "#6b4fa5"
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function TopologyGraph({ nodes, manualLinks, trafficEdges }: Props) {
  const navigate = useNavigate();
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);

  const width = 700;
  const height = 460;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.min(width, height) / 2 - 70;

  // Node'ları daire üzerine yerleştir
  const positions = useMemo(() => {
    const map: Record<string, { x: number; y: number }> = {};
    nodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2;
      map[node.id] = {
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle)
      };
    });
    return map;
  }, [nodes]);

  const maxTraffic = Math.max(...trafficEdges.map((e) => e.total_bytes), 1);

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      {/* Trafik bazlı kenarlar — kalınlık trafik hacmine göre */}
      {trafficEdges.map((edge, i) => {
        const a = positions[edge.device_a_id];
        const b = positions[edge.device_b_id];
        if (!a || !b) return null;
        const strokeWidth = 1 + (edge.total_bytes / maxTraffic) * 5;
        const key = `traffic-${edge.device_a_id}-${edge.device_b_id}`;
        return (
          <g key={key} onMouseEnter={() => setHoveredEdge(key)} onMouseLeave={() => setHoveredEdge(null)}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--text-accent)" strokeWidth={strokeWidth} opacity={0.5} />
            {hoveredEdge === key && (
              <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 8} textAnchor="middle" fontSize="11" fill="var(--text-accent)" fontWeight="500">
                {formatBytes(edge.total_bytes)}
              </text>
            )}
          </g>
        );
      })}

      {/* Manuel fiziksel bağlantılar — kesikli çizgi */}
      {manualLinks.map((link) => {
        const a = positions[link.device_a_id];
        const b = positions[link.device_b_id];
        if (!a || !b) return null;
        return (
          <line
            key={link.id}
            x1={a.x} y1={a.y} x2={b.x} y2={b.y}
            stroke="var(--border-strong)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        );
      })}

      {/* Node'lar */}
      {nodes.map((node) => {
        const pos = positions[node.id];
        if (!pos) return null;
        const color = DEVICE_TYPE_COLOR[node.device_type] || "#71717a";
        const isDown = node.status !== "active";

        return (
          <g key={node.id} onClick={() => navigate(`/devices/${node.id}`)} className="cursor-pointer">
            <circle cx={pos.x} cy={pos.y} r={22} fill="var(--surface-1)" stroke={isDown ? "var(--text-danger)" : color} strokeWidth={2} />
            <circle cx={pos.x + 15} cy={pos.y - 15} r={5} fill={isDown ? "var(--text-danger)" : "var(--text-success)"} stroke="var(--surface-1)" strokeWidth={1.5} />
            <text x={pos.x} y={pos.y + 38} textAnchor="middle" fontSize="12" fontWeight="500" fill="var(--text-primary)">
              {node.name}
            </text>
            <text x={pos.x} y={pos.y + 52} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
              {node.ip_address}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
