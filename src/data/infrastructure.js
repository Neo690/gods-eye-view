import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create fresh datacenter, dam and nuclear-plant layers without starting or
 * loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters, dams then nuclear plants, with stable
 *   standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacentersUrl = INFRASTRUCTURE_DATA_URLS['local-datacenters'];
  const damsUrl = INFRASTRUCTURE_DATA_URLS['local-dams'];
  const nuclearUrl = INFRASTRUCTURE_DATA_URLS['local-nuclear'];
  const datacenters = createLocalGeoJsonLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      osmDerived: true,
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'USACE',
      osmDerived: true,
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  const nuclear = createLocalGeoJsonLayer(
    {
      id: 'local-nuclear',
      url: nuclearUrl,
      name: 'Nuclear Plants',
      color: '#ffd400', // Amber
      icon: '☢',
      source: 'Wikidata',
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  return [datacenters, dams, nuclear];
}
