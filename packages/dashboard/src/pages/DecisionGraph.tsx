import { useEffect, useRef, useState } from 'react';
import * as d3 from 'd3';
import { api, type Project, type Decision } from '../api.js';

interface GraphNode extends d3.SimulationNodeDatum {
  id: string;
  label: string;
  kind: 'project' | Decision['kind'];
  r: number;
}

interface GraphLink extends d3.SimulationLinkDatum<GraphNode> {
  source: string | GraphNode;
  target: string | GraphNode;
}

export function DecisionGraph() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api.projects.list()
      .then(ps => setProjects(ps))
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (projects.length === 0 || !svgRef.current) return;

    const target = selectedProject === 'all' ? projects : projects.filter(p => p.id === selectedProject);
    if (target.length === 0) return;

    Promise.all(target.map(p => api.projects.decisions(p.id).then(ds => ({ project: p, decisions: ds }))))
      .then(results => buildGraph(svgRef.current!, results))
      .catch(() => {/* non-fatal */});
  }, [projects, selectedProject]);

  if (loading) return <div className="loading">Loading…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div className="stacked">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label style={{ color: 'var(--text2)', fontSize: 13 }}>Project:</label>
        <select
          value={selectedProject}
          onChange={e => setSelectedProject(e.target.value)}
          style={{ background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', padding: '6px 10px', borderRadius: 'var(--radius)', fontSize: 13 }}
        >
          <option value="all">All projects</option>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <div className="graph-container">
        <svg ref={svgRef} />
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {legend.map(l => (
          <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text2)' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: l.color, display: 'inline-block' }} />
            {l.label}
          </div>
        ))}
      </div>
    </div>
  );
}

const kindColor: Record<string, string> = {
  project: '#58a6ff',
  architecture: '#79c0ff',
  library: '#bc8cff',
  pattern: '#3fb950',
  naming: '#8b949e',
  security: '#f85149',
  other: '#d29922',
};

const legend = [
  { label: 'Project', color: kindColor.project },
  { label: 'Architecture', color: kindColor.architecture },
  { label: 'Library', color: kindColor.library },
  { label: 'Pattern', color: kindColor.pattern },
  { label: 'Security', color: kindColor.security },
  { label: 'Other', color: kindColor.other },
];

function buildGraph(
  svgEl: SVGSVGElement,
  results: Array<{ project: Project; decisions: Decision[] }>,
) {
  const width = svgEl.clientWidth || 800;
  const height = svgEl.clientHeight || 500;

  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  for (const { project, decisions } of results) {
    nodes.push({ id: `p-${project.id}`, label: project.name, kind: 'project', r: 18 });
    for (const d of decisions) {
      const nodeId = `d-${d.id}`;
      nodes.push({ id: nodeId, label: d.summary.slice(0, 30), kind: d.kind, r: 9 });
      links.push({ source: `p-${project.id}`, target: nodeId });
    }
  }

  const svg = d3.select(svgEl);
  svg.selectAll('*').remove();

  svg.append('defs').append('marker')
    .attr('id', 'arrow')
    .attr('viewBox', '0 -5 10 10')
    .attr('refX', 18)
    .attr('markerWidth', 6)
    .attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path')
    .attr('fill', '#30363d')
    .attr('d', 'M0,-5L10,0L0,5');

  const sim = d3.forceSimulation<GraphNode>(nodes)
    .force('link', d3.forceLink<GraphNode, GraphLink>(links).id(n => n.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2))
    .force('collision', d3.forceCollide<GraphNode>(n => n.r + 6));

  const link = svg.append('g')
    .selectAll('line')
    .data(links)
    .join('line')
    .attr('stroke', '#30363d')
    .attr('stroke-width', 1)
    .attr('marker-end', 'url(#arrow)');

  const node = svg.append('g')
    .selectAll<SVGCircleElement, GraphNode>('circle')
    .data(nodes)
    .join('circle')
    .attr('r', n => n.r)
    .attr('fill', n => kindColor[n.kind] ?? (kindColor['other'] as string))
    .attr('stroke', '#161b22')
    .attr('stroke-width', 2)
    .style('cursor', 'pointer')
    .call(
      d3.drag<SVGCircleElement, GraphNode>()
        .on('start', (event, d) => {
          if (!event.active) sim.alphaTarget(0.3).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on('end', (event, d) => {
          if (!event.active) sim.alphaTarget(0);
          d.fx = null; d.fy = null;
        }),
    );

  const label = svg.append('g')
    .selectAll<SVGTextElement, GraphNode>('text')
    .data(nodes)
    .join('text')
    .attr('font-size', n => n.kind === 'project' ? 12 : 10)
    .attr('fill', '#e6edf3')
    .attr('text-anchor', 'middle')
    .attr('dy', n => n.r + 14)
    .text(n => n.label);

  node.append('title').text(n => n.label);

  sim.on('tick', () => {
    link
      .attr('x1', l => (l.source as GraphNode).x ?? 0)
      .attr('y1', l => (l.source as GraphNode).y ?? 0)
      .attr('x2', l => (l.target as GraphNode).x ?? 0)
      .attr('y2', l => (l.target as GraphNode).y ?? 0);
    node.attr('cx', n => n.x ?? 0).attr('cy', n => n.y ?? 0);
    label.attr('x', n => n.x ?? 0).attr('y', n => n.y ?? 0);
  });
}
