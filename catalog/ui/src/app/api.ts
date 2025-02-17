import parseDuration from 'parse-duration';
import {
  AnarchyAction,
  AnarchyGovernor,
  AnarchySubject,
  AnarchyRun,
  CatalogItem,
  JSONPatch,
  K8sObject,
  K8sObjectList,
  ResourceClaim,
  ResourceHandle,
  ResourcePool,
  ResourceProvider,
  ServiceNamespace,
  Workshop,
  WorkshopProvision,
  WorkshopSpecUserAssignment,
  UserList,
  Session,
  Nullable,
  ResourceType,
} from '@app/types';
import { store, selectImpersonationUser } from '@app/store';
import {
  checkAccessControl,
  displayName,
  recursiveAssign,
  BABYLON_DOMAIN,
  DEMO_DOMAIN,
  getCostTracker,
  compareStringDates,
  canExecuteAction,
} from '@app/util';

declare const window: Window &
  typeof globalThis & {
    sessionPromiseInstance?: Promise<Session>;
  };

type CreateServiceRequestOptScheduleStart = {
  date: Date;
};
interface CreateServiceRequestOptScheduleStartLifespan extends CreateServiceRequestOptScheduleStart {
  type: 'lifespan';
}
interface CreateServiceRequestOptScheduleStartResource extends CreateServiceRequestOptScheduleStart {
  type: 'resource';
  autoStop: Date;
}
type CreateServiceRequestOpt = {
  catalogItem: CatalogItem;
  catalogNamespaceName: string;
  serviceNamespace: ServiceNamespace;
  groups: string[];
  isAdmin: boolean;
  parameterValues?: CreateServiceRequestParameterValues;
  usePoolIfAvailable: boolean;
  stopDate?: Date;
  endDate: Date;
  start?: CreateServiceRequestOptScheduleStartLifespan | CreateServiceRequestOptScheduleStartResource;
};

type CreateWorkshopPovisionOpt = {
  catalogItem: CatalogItem;
  concurrency: number;
  count: number;
  parameters: any;
  startDelay: number;
  workshop: Workshop;
};

export type CreateServiceRequestParameterValues = {
  [name: string]: boolean | number | string;
};

type K8sObjectListCommonOpt = {
  continue?: string;
  disableImpersonation?: boolean;
  labelSelector?: string;
  limit?: number;
  namespace?: string;
};

interface K8sObjectListOpt extends K8sObjectListCommonOpt {
  apiVersion: string;
  plural: string;
}

export async function apiFetch(path: string, opt?: object): Promise<Response> {
  const session = await getApiSession();

  const options = opt ? JSON.parse(JSON.stringify(opt)) : {};
  options.method = options.method || 'GET';
  options.headers = options.headers || {};
  options.body = options.body || null;
  options.headers['Authentication'] = `Bearer ${session?.token}`;

  if (!options.disableImpersonation) {
    const impersonateUser = selectImpersonationUser(store.getState());
    if (impersonateUser) {
      options.headers['Impersonate-User'] = impersonateUser;
    }
  }

  let resp = await window.fetch(path, options);
  if (resp.status >= 400 && resp.status < 600) {
    if (resp.status === 401) {
      // Retry with a refreshed session
      const session = await getApiSession(true);
      options.headers['Authentication'] = `Bearer ${session.token}`;
      resp = await window.fetch(path, options);
      if (resp.status >= 400 && resp.status < 600) {
        throw resp;
      }
    } else {
      throw resp;
    }
  }

  return resp;
}

export async function publicFetcher(path: string, opt?: Record<string, unknown>) {
  const response = await window.fetch(path, opt);
  if (response.status >= 400 && response.status < 600) {
    throw response;
  }
  const contentType = response.headers.get('Content-Type');
  if (contentType?.includes('text/') || contentType?.includes('application/octet-stream')) return response.text();
  return response.json();
}

export async function fetcher(path: string, opt?: Record<string, unknown>) {
  const response = await apiFetch(path, opt);
  const contentType = response.headers.get('Content-Type');
  if (contentType?.includes('text/') || contentType?.includes('application/octet-stream')) return response.text();
  return response.json();
}

export async function fetcherItemsInAllPages(pathFn: (continueId: string) => string, opts?: Record<string, unknown>) {
  const items = [];
  let continueId: Nullable<string> = null;
  while (continueId || continueId === null) {
    const res: { metadata: { continue: string }; items: unknown[] } = await fetcher(pathFn(continueId), opts);
    continueId = res.metadata.continue || '';
    items.push(...res.items);
  }
  return items;
}

export async function assignWorkshopUser({
  resourceClaimName,
  userName,
  email,
  workshop,
}: {
  resourceClaimName: string;
  userName: string;
  email: string;
  workshop: Workshop;
}) {
  const userAssignmentIdx: number = workshop.spec.userAssignments.findIndex(
    (item) => resourceClaimName === item.resourceClaimName && userName === item.userName
  );
  const userAssignment = workshop.spec.userAssignments[userAssignmentIdx];
  if (!userAssignment) {
    console.error(`Unable to assign, ${resourceClaimName} ${userName} not found.`);
    return workshop;
  } else if (userAssignment.assignment?.email === email || (!userAssignment.assignment?.email && !email)) {
    return workshop;
  }

  const jsonPatch: JSONPatch = [];
  if (resourceClaimName) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/resourceClaimName`,
      value: resourceClaimName,
    });
  }
  if (userName) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/userName`,
      value: userName,
    });
  }
  if (userAssignment.assignment) {
    jsonPatch.push({
      op: 'test',
      path: `/spec/userAssignments/${userAssignmentIdx}/assignment/email`,
      value: workshop.spec.userAssignments[userAssignmentIdx].assignment.email,
    });
    if (email) {
      jsonPatch.push({
        op: 'replace',
        path: `/spec/userAssignments/${userAssignmentIdx}/assignment/email`,
        value: email,
      });
    } else {
      jsonPatch.push({
        op: 'remove',
        path: `/spec/userAssignments/${userAssignmentIdx}/assignment`,
      });
    }
  } else if (email) {
    jsonPatch.push({
      op: 'add',
      path: `/spec/userAssignments/${userAssignmentIdx}/assignment`,
      value: { email: email },
    });
  } else {
    return workshop;
  }

  const updatedWorkshop = await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    jsonPatch: jsonPatch,
  });
  return updatedWorkshop;
}

export function dateToApiString(date: Date) {
  return date.toISOString().split('.')[0] + 'Z';
}

export async function bulkAssignWorkshopUsers({
  emails,
  workshop,
}: {
  emails: string[];
  workshop: Workshop;
}): Promise<{ unassignedEmails: string[]; userAssignments: WorkshopSpecUserAssignment[]; workshop: Workshop }> {
  if (!workshop.spec.userAssignments) {
    return {
      unassignedEmails: emails,
      userAssignments: [],
      workshop: workshop,
    };
  }

  let _workshop = Object.assign({}, workshop);
  while (true) {
    const userAssignments: WorkshopSpecUserAssignment[] = [];
    const unassignedEmails: string[] = [];
    for (const email of emails) {
      const userAssignment = _workshop.spec.userAssignments.find((item) => item.assignment?.email === email);
      if (userAssignment) {
        userAssignments.push(userAssignment);
      } else {
        unassignedEmails.push(email);
      }
    }
    for (const userAssignment of _workshop.spec.userAssignments) {
      if (!userAssignment.assignment) {
        userAssignment.assignment = {
          email: unassignedEmails.shift(),
        };
        userAssignments.push(userAssignment);
      }
      if (unassignedEmails.length === 0) {
        break;
      }
    }
    try {
      _workshop = await updateWorkshop(_workshop);
      return {
        unassignedEmails: unassignedEmails,
        userAssignments: userAssignments,
        workshop: _workshop,
      };
    } catch (error: any) {
      if (error.status === 409) {
        _workshop = await getWorkshop(workshop.metadata.namespace, workshop.metadata.name);
      } else {
        throw error;
      }
    }
  }
}

export async function checkSalesforceId(
  id: string,
  debouncedApiFetch: (path: string) => Promise<unknown>
): Promise<boolean> {
  if (!id) {
    return false;
  }
  try {
    await debouncedApiFetch(`/api/salesforce/opportunity/${id}`);
  } catch (error) {
    return false;
  }
  return true;
}

async function createK8sObject<Type extends K8sObject>(definition: Type): Promise<Type> {
  const apiVersion = definition.apiVersion;
  const namespace = definition.metadata.namespace;
  const plural = definition.kind.toLowerCase() + 's';

  const path = namespace ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}` : `/apis/${apiVersion}/${plural}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(definition),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'POST',
  });
  return await resp.json();
}

async function createResourceClaim(definition: ResourceClaim) {
  return await createK8sObject<ResourceClaim>(definition);
}

export async function createResourcePool(definition: ResourcePool) {
  return await createK8sObject<ResourcePool>(definition);
}

export async function createServiceRequest({
  catalogItem,
  catalogNamespaceName,
  groups,
  isAdmin,
  parameterValues,
  serviceNamespace,
  start,
  stopDate,
  endDate,
  usePoolIfAvailable,
}: CreateServiceRequestOpt): Promise<ResourceClaim> {
  const baseUrl = window.location.href.replace(/^([^/]+\/\/[^/]+)\/.*/, '$1');
  const session = await getApiSession();
  const access = checkAccessControl(catalogItem.spec.accessControl, groups, isAdmin);

  const requestResourceClaim: ResourceClaim = {
    apiVersion: 'poolboy.gpte.redhat.com/v1',
    kind: 'ResourceClaim',
    metadata: {
      annotations: {
        [`${BABYLON_DOMAIN}/catalogDisplayName`]: catalogNamespaceName || catalogItem.metadata.namespace,
        [`${BABYLON_DOMAIN}/catalogItemDisplayName`]: displayName(catalogItem),
        [`${BABYLON_DOMAIN}/requester`]: session.user,
        [`${BABYLON_DOMAIN}/category`]: catalogItem.metadata.labels?.[`${BABYLON_DOMAIN}/category`],
        [`${BABYLON_DOMAIN}/url`]: `${baseUrl}/services/${serviceNamespace.name}/${catalogItem.metadata.name}`,
        ...(usePoolIfAvailable === false ? { ['poolboy.gpte.redhat.com/resource-pool-name']: 'disable' } : {}),
        ...(catalogItem.spec.userData
          ? { [`${BABYLON_DOMAIN}/userData`]: JSON.stringify(catalogItem.spec.userData) }
          : {}),
        ...(catalogItem.spec.messageTemplates?.info
          ? { [`${DEMO_DOMAIN}/info-message-template`]: JSON.stringify(catalogItem.spec.messageTemplates.info) }
          : {}),
      },
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
        ...(catalogItem.metadata.labels?.['gpte.redhat.com/asset-uuid']
          ? { 'gpte.redhat.com/asset-uuid': catalogItem.metadata.labels['gpte.redhat.com/asset-uuid'] }
          : {}),
        ...(catalogItem.spec.bookbag ? { [`${BABYLON_DOMAIN}/labUserInterface`]: 'bookbag' } : {}),
      },
      name: catalogItem.metadata.name,
      namespace: serviceNamespace.name,
    },
    spec: {
      provider: {
        name: catalogItem.metadata.name,
        parameterValues: {
          purpose: parameterValues.purpose as string,
          ...(start ? { start_timestamp: dateToApiString(start.date) } : {}),
          ...(start && start.type === 'resource' && start.autoStop
            ? { stop_timestamp: dateToApiString(start.autoStop) }
            : stopDate
            ? { stop_timestamp: dateToApiString(stopDate) }
            : {}),
        },
      },
      lifespan: {
        ...(start && start.type === 'lifespan' ? { start: dateToApiString(start.date) } : {}),
        end: dateToApiString(endDate),
      },
    },
  };

  if (access !== 'allow') {
    return null;
  }
  // Once created the ResourceClaim is completely independent of the catalog item.
  // This allows the catalog item to be changed or removed without impacting provisioned
  // services. All relevant configuration from the CatalogItem needs to be copied into
  // the ResourceClaim.

  // Add display name annotations for components
  for (const [key, value] of Object.entries(catalogItem.metadata.annotations || {})) {
    if (key.startsWith(`${BABYLON_DOMAIN}/displayNameComponent`)) {
      requestResourceClaim.spec.provider.parameterValues[key] = value;
    }
  }

  // Copy all parameter values into the ResourceClaim
  for (const parameter of catalogItem.spec.parameters || []) {
    // passed parameter value or default
    const value: boolean | number | string =
      parameterValues?.[parameter.name] !== undefined
        ? parameterValues[parameter.name]
        : parameter.openAPIV3Schema?.default !== undefined
        ? parameter.openAPIV3Schema.default
        : parameter.value;

    // Set annotation for parameter
    if (parameter.annotation && value !== undefined) {
      requestResourceClaim.spec.provider.parameterValues[parameter.annotation] = String(value);
    }
  }

  // Purpose & SFDC
  if (parameterValues.purpose) {
    requestResourceClaim.metadata.annotations[`${DEMO_DOMAIN}/purpose`] = parameterValues.purpose as string;
  }
  if (parameterValues.purpose_activity) {
    requestResourceClaim.metadata.annotations[`${DEMO_DOMAIN}/purpose-activity`] =
      parameterValues.purpose_activity as string;
  }
  if (parameterValues.purpose_explanation) {
    requestResourceClaim.metadata.annotations[`${DEMO_DOMAIN}/purpose-explanation`] =
      parameterValues.purpose_explanation as string;
  }
  if (parameterValues.salesforce_id) {
    requestResourceClaim.metadata.annotations[`${DEMO_DOMAIN}/salesforce-id`] = parameterValues.salesforce_id as string;
  }

  let n = 0;
  while (true) {
    try {
      const resourceClaim = await createResourceClaim(requestResourceClaim);
      return resourceClaim;
    } catch (error: any) {
      if (error.status === 409) {
        n++;
        requestResourceClaim.metadata.name = `${catalogItem.metadata.name}-${n}`;
        requestResourceClaim.metadata.annotations[
          `${BABYLON_DOMAIN}/url`
        ] = `${baseUrl}/services/${serviceNamespace.name}/${catalogItem.metadata.name}-${n}`;
      } else {
        throw error;
      }
    }
  }
}

export async function createWorkshop({
  accessPassword,
  catalogItem,
  description,
  displayName,
  openRegistration,
  serviceNamespace,
  stopDate,
  endDate,
  startDate,
}: {
  accessPassword?: string;
  catalogItem: CatalogItem;
  description?: string;
  displayName?: string;
  openRegistration: boolean;
  serviceNamespace: ServiceNamespace;
  endDate?: Date;
  stopDate?: Date;
  startDate?: Date;
}): Promise<Workshop> {
  const definition: Workshop = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'Workshop',
    metadata: {
      name: catalogItem.metadata.name,
      namespace: serviceNamespace.name,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
        ...(catalogItem.metadata.labels?.['gpte.redhat.com/asset-uuid']
          ? { 'gpte.redhat.com/asset-uuid': catalogItem.metadata.labels['gpte.redhat.com/asset-uuid'] }
          : {}),
      },
      annotations: {
        [`${BABYLON_DOMAIN}/category`]: catalogItem.metadata.labels?.[`${BABYLON_DOMAIN}/category`],
        ...(catalogItem.spec.multiuser && catalogItem.spec.messageTemplates?.user
          ? { [`${DEMO_DOMAIN}/user-message-template`]: JSON.stringify(catalogItem.spec.messageTemplates?.user) }
          : catalogItem.spec.messageTemplates?.info
          ? { [`${DEMO_DOMAIN}/info-message-template`]: JSON.stringify(catalogItem.spec.messageTemplates?.info) }
          : {}),
      },
    },
    spec: {
      multiuserServices: catalogItem.spec.multiuser,
      openRegistration: openRegistration,
      userAssignments: [],
      lifespan: {
        ...(startDate ? { start: dateToApiString(startDate) } : {}),
        ...(endDate ? { end: dateToApiString(endDate) } : {}),
      },
      ...(stopDate ? { actionSchedule: { stop: dateToApiString(stopDate) } } : {}),
    },
  };
  if (accessPassword) {
    definition.spec.accessPassword = accessPassword;
  }
  if (description) {
    definition.spec.description = description;
  }
  if (displayName) {
    definition.spec.displayName = displayName;
  }

  let n = 0;
  while (true) {
    try {
      return await createK8sObject(definition);
    } catch (error: any) {
      if (error.status === 409) {
        n++;
        definition.metadata.name = `${catalogItem.metadata.name}-${n}`;
      } else {
        throw error;
      }
    }
  }
}

export async function createWorkshopForMultiuserService({
  accessPassword,
  description,
  displayName,
  openRegistration,
  resourceClaim,
}: {
  accessPassword?: string;
  description: string;
  displayName: string;
  openRegistration: boolean;
  resourceClaim: ResourceClaim;
}): Promise<{ resourceClaim: ResourceClaim; workshop: Workshop }> {
  const catalogItemName: string = resourceClaim.metadata.labels?.[`${BABYLON_DOMAIN}/catalogItemName`];
  const catalogItemNamespace: string = resourceClaim.metadata.labels?.[`${BABYLON_DOMAIN}/catalogItemNamespace`];
  const definition: Workshop = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'Workshop',
    metadata: {
      name: resourceClaim.metadata.name,
      namespace: resourceClaim.metadata.namespace,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItemName,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItemNamespace,
      },
      annotations: {
        [`${BABYLON_DOMAIN}/category`]: resourceClaim.metadata.annotations?.[`${BABYLON_DOMAIN}/category`],
      },
      ownerReferences: [
        {
          apiVersion: 'poolboy.gpte.redhat.com/v1',
          controller: true,
          kind: 'ResourceClaim',
          name: resourceClaim.metadata.name,
          uid: resourceClaim.metadata.uid,
        },
      ],
    },
    spec: {
      multiuserServices: true,
      openRegistration: openRegistration,
      provisionDisabled: true,
      userAssignments: [],
    },
  };
  if (accessPassword) {
    definition.spec.accessPassword = accessPassword;
  }
  if (description) {
    definition.spec.description = description;
  }
  if (displayName) {
    definition.spec.displayName = displayName;
  }
  // Use GUID as workshop id
  if (resourceClaim.status?.resourceHandle) {
    definition.metadata.labels[`${BABYLON_DOMAIN}/workshop-id`] = resourceClaim.status?.resourceHandle.name.replace(
      /^guid-/,
      ''
    );
  }

  let n = 0;
  while (true) {
    try {
      const workshop = await createK8sObject(definition);
      const patchedResourceClaim = await patchResourceClaim(
        resourceClaim.metadata.namespace,
        resourceClaim.metadata.name,
        {
          metadata: {
            labels: {
              [`${BABYLON_DOMAIN}/workshop`]: workshop.metadata.name,
            },
          },
        }
      );
      return { resourceClaim: patchedResourceClaim, workshop: workshop };
    } catch (error: any) {
      if (error.status === 409) {
        n++;
        definition.metadata.name = `${definition.metadata.name}-${n}`;
      } else {
        throw error;
      }
    }
  }
}

export async function createWorkshopProvision({
  catalogItem,
  concurrency,
  count,
  parameters,
  startDelay,
  workshop,
}: CreateWorkshopPovisionOpt) {
  const definition: WorkshopProvision = {
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    kind: 'WorkshopProvision',
    metadata: {
      name: workshop.metadata.name,
      namespace: workshop.metadata.namespace,
      labels: {
        [`${BABYLON_DOMAIN}/catalogItemName`]: catalogItem.metadata.name,
        [`${BABYLON_DOMAIN}/catalogItemNamespace`]: catalogItem.metadata.namespace,
        ...(catalogItem.metadata.labels?.['gpte.redhat.com/asset-uuid']
          ? { 'gpte.redhat.com/asset-uuid': catalogItem.metadata.labels['gpte.redhat.com/asset-uuid'] }
          : {}),
      },
      annotations: {
        [`${BABYLON_DOMAIN}/category`]: catalogItem.metadata.labels?.[`${BABYLON_DOMAIN}/category`],
      },
      ownerReferences: [
        {
          apiVersion: `${BABYLON_DOMAIN}/v1`,
          controller: true,
          kind: 'Workshop',
          name: workshop.metadata.name,
          uid: workshop.metadata.uid,
        },
      ],
    },
    spec: {
      catalogItem: {
        name: catalogItem.metadata.name,
        namespace: catalogItem.metadata.namespace,
      },
      concurrency: concurrency,
      count: count,
      parameters: parameters,
      startDelay: startDelay,
      workshopName: workshop.metadata.name,
    },
  };

  return await createK8sObject(definition);
}

export async function getApiSession(forceRefresh = false) {
  const sessionPromise = window.sessionPromiseInstance;
  let session: Session;
  if (!sessionPromise || forceRefresh) {
    session = await fetchApiSession();
  } else {
    session = await sessionPromise;
  }
  return session;
}

export async function getAnarchySubject(namespace: string, name: string) {
  return (await getNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    namespace,
    'anarchysubjects',
    name
  )) as AnarchySubject;
}

async function getK8sObject<Type extends K8sObject>({
  apiVersion,
  name,
  namespace,
  plural,
}: {
  apiVersion: string;
  name: string;
  namespace?: string;
  plural: string;
}): Promise<Type> {
  const path = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}/${name}`
    : `/apis/${apiVersion}/${plural}/${name}`;
  const resp = await apiFetch(path);
  return await resp.json();
}

export async function getResourcePool(name: string) {
  return (await getNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourcepools',
    name
  )) as ResourcePool;
}

export async function getUserInfo(user: string): Promise<any> {
  const session = await getApiSession(true);
  const resp = await fetch(`/auth/users/${user}`, {
    headers: {
      Authentication: `Bearer ${session.token}`,
    },
  });
  return await resp.json();
}

async function getWorkshop(namespace: string, name: string) {
  return await getK8sObject<Workshop>({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    name: name,
    namespace: namespace,
    plural: 'workshops',
  });
}

function fetchApiSession() {
  window.sessionPromiseInstance = fetch('/auth/session')
    .then((response) => {
      if (response.ok) return response.json();
      throw new Error(response.statusText);
    })
    .catch(() => {
      window.location.href = '/?n=' + new Date().getTime();
    });
  return window.sessionPromiseInstance;
}

export async function listUsers(opt?: K8sObjectListCommonOpt) {
  return (await listK8sObjects({
    apiVersion: 'user.openshift.io/v1',
    plural: 'users',
    ...opt,
  })) as UserList;
}

export async function deleteAnarchyAction(anarchyAction: AnarchyAction) {
  return await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyAction.metadata.namespace,
    'anarchyactions',
    anarchyAction.metadata.name
  );
}

export async function deleteAnarchyGovernor(anarchyGovernor: AnarchyGovernor) {
  return await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyGovernor.metadata.namespace,
    'anarchygovernors',
    anarchyGovernor.metadata.name
  );
}

export async function deleteAnarchyRun(anarchyRun: AnarchyRun) {
  return await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchyRun.metadata.namespace,
    'anarchyruns',
    anarchyRun.metadata.name
  );
}

export async function deleteAnarchySubject(anarchySubject: AnarchySubject) {
  return await deleteNamespacedCustomObject(
    'anarchy.gpte.redhat.com',
    'v1',
    anarchySubject.metadata.namespace,
    'anarchysubjects',
    anarchySubject.metadata.name
  );
}

async function deleteK8sObject<Type extends K8sObject>(definition: Type): Promise<Type | null> {
  const plural = definition.kind.toLowerCase() + 's';
  const path = definition.metadata.namespace
    ? `/apis/${definition.apiVersion}/namespaces/${definition.metadata.namespace}/${plural}/${definition.metadata.name}`
    : `/apis/${definition.apiVersion}/${plural}/${definition.metadata.name}`;
  try {
    const resp = await apiFetch(path, { method: 'DELETE' });
    return await resp.json();
  } catch (error: any) {
    if (error.status === 404) {
      return null;
    } else {
      throw error;
    }
  }
}

export async function deleteResourceClaim(resourceClaim: ResourceClaim) {
  return (await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name
  )) as ResourceClaim;
}

export async function deleteResourceHandle(resourceHandle: ResourceHandle) {
  return await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceHandle.metadata.namespace,
    'resourcehandles',
    resourceHandle.metadata.name
  );
}

export async function deleteResourcePool(resourcePool: ResourcePool) {
  return await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourcePool.metadata.namespace,
    'resourcepools',
    resourcePool.metadata.name
  );
}

export async function deleteResourceProvider(resourceProvider: ResourceProvider) {
  return await deleteNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceProvider.metadata.namespace,
    'resourcehandles',
    resourceProvider.metadata.name
  );
}

export async function deleteWorkshop(workshop: Workshop) {
  return await deleteK8sObject(workshop);
}

export async function setWorkshopLifespanEnd(workshop: Workshop, date: Date = new Date()) {
  const patch = { spec: { lifespan: { end: dateToApiString(date) } } };
  return await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    patch,
  });
}

export async function stopWorkshop(workshop: Workshop, date: Date = new Date()) {
  const patch = { spec: { actionSchedule: { stop: dateToApiString(date) } } };
  return await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    patch,
  });
}

export async function startWorkshop(workshop: Workshop, dateString: string, resourceClaims: ResourceClaim[] = []) {
  const now = new Date();
  let defaultRuntimes = [];
  for (const resourceClaim of resourceClaims) {
    defaultRuntimes.push(
      ...(resourceClaim.status?.resources
        ? resourceClaim.status.resources
            .filter((r) => (r.state?.spec?.vars?.action_schedule?.default_runtime ? true : false))
            .map((r) => parseDuration(r.state.spec.vars.action_schedule.default_runtime))
        : [])
    );
  }
  const patch = {
    spec: {
      actionSchedule: {
        start: dateToApiString(now),
        stop: dateToApiString(
          defaultRuntimes.length > 0
            ? new Date(now.getTime() + Math.min(...defaultRuntimes))
            : new Date(now.getTime() + 12 * 60 * 60 * 1000)
        ),
      },
      lifespan: {
        start: dateString || dateToApiString(now),
      },
    },
  };
  return await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    patch,
  });
}

export async function startWorkshopServices(workshop: Workshop, resourceClaims: ResourceClaim[] = []) {
  const now = new Date();
  let defaultRuntimes = [];
  for (const resourceClaim of resourceClaims) {
    defaultRuntimes.push(
      ...(resourceClaim.status?.resources
        ? resourceClaim.status.resources
            .filter((r) => (r.state?.spec?.vars?.action_schedule?.default_runtime ? true : false))
            .map((r) => parseDuration(r.state.spec.vars.action_schedule.default_runtime))
        : [])
    );
  }
  const patch = {
    spec: {
      actionSchedule: {
        start: dateToApiString(now),
        stop: dateToApiString(
          defaultRuntimes.length > 0
            ? new Date(now.getTime() + Math.min(...defaultRuntimes))
            : new Date(now.getTime() + 12 * 60 * 60 * 1000)
        ),
      },
    },
  };
  return await patchWorkshop({
    name: workshop.metadata.name,
    namespace: workshop.metadata.namespace,
    patch,
  });
}

export async function forceDeleteAnarchySubject(anarchySubject: AnarchySubject) {
  if ((anarchySubject.metadata.finalizers || []).length > 0) {
    await patchNamespacedCustomObject(
      'anarchy.gpte.redhat.com',
      'v1',
      anarchySubject.metadata.namespace,
      'anarchysubjects',
      anarchySubject.metadata.name,
      { metadata: { finalizers: null } }
    );
  }
  if (!anarchySubject.metadata.deletionTimestamp) {
    await deleteAnarchySubject(anarchySubject);
  }
}

export async function patchK8sObject<Type extends K8sObject>({
  apiVersion,
  jsonPatch,
  name,
  namespace,
  patch,
  plural,
}: {
  apiVersion: string;
  jsonPatch?: JSONPatch;
  name: string;
  namespace?: string;
  patch?: Record<string, unknown>;
  plural: string;
}): Promise<Type> {
  const path = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}/${name}`
    : `/apis/${apiVersion}/${plural}/${name}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(jsonPatch || patch),
    headers: {
      'Content-Type': jsonPatch ? 'application/json-patch+json' : 'application/merge-patch+json',
    },
    method: 'PATCH',
  });
  return await resp.json();
}

export async function patchK8sObjectByPath<Type extends K8sObject>({
  patch,
  path,
}: {
  patch: Record<string, unknown>;
  path: string;
}): Promise<Type> {
  const resp = await apiFetch(path, {
    body: JSON.stringify(patch),
    headers: {
      'Content-Type': 'application/merge-patch+json',
    },
    method: 'PATCH',
  });
  return await resp.json();
}

export async function patchResourceClaim(namespace: string, name: string, patch: Record<string, unknown>) {
  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    namespace,
    'resourceclaims',
    name,
    patch
  )) as ResourceClaim;
}

export async function patchResourcePool(name: string, patch: any) {
  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    'poolboy',
    'resourcepools',
    name,
    patch
  )) as ResourcePool;
}

export async function patchWorkshop({
  name,
  namespace,
  jsonPatch,
  patch,
}: {
  name: string;
  namespace: string;
  jsonPatch?: JSONPatch;
  patch?: Record<string, unknown>;
}): Promise<Workshop> {
  return await patchK8sObject({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    jsonPatch: jsonPatch,
    name: name,
    namespace: namespace,
    plural: 'workshops',
    patch: patch,
  });
}

export async function patchWorkshopProvision({
  name,
  namespace,
  jsonPatch,
  patch,
}: {
  name: string;
  namespace: string;
  jsonPatch?: JSONPatch;
  patch?: Record<string, unknown>;
}): Promise<WorkshopProvision> {
  return await patchK8sObject({
    apiVersion: `${BABYLON_DOMAIN}/v1`,
    jsonPatch: jsonPatch,
    name: name,
    namespace: namespace,
    plural: 'workshopprovisions',
    patch: patch,
  });
}

export async function requestStatusForAllResourcesInResourceClaim(resourceClaim: ResourceClaim) {
  const requestDate = new Date();
  const requestTimestamp = dateToApiString(requestDate);
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  const resourcesToRequestStatus = [];
  for (const resource of resourceClaim.status?.resources) {
    if (canExecuteAction(resource.state, 'status')) {
      resourcesToRequestStatus.push(resource.name);
    }
  }
  for (let i = 0; i < data.spec.resources?.length; ++i) {
    if (resourcesToRequestStatus.includes(data.spec.resources[i].name)) {
      data.spec.resources[i].template.spec.vars.check_status_request_timestamp = requestTimestamp;
    }
  }
  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
}

export async function scheduleStopForAllResourcesInResourceClaim(resourceClaim: ResourceClaim, date: Date) {
  const stopTimestamp = dateToApiString(date);
  let patch: any = {};
  if (resourceClaim.spec?.provider?.parameterValues?.['stop_timestamp']) {
    patch = {
      spec: {
        provider: {
          parameterValues: {
            stop_timestamp: stopTimestamp,
          },
        },
      },
    };
  } else {
    patch = {
      spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
    };
    const resourcesToStop = [];
    for (const resource of resourceClaim.status?.resources) {
      if (canExecuteAction(resource.state, 'stop')) {
        resourcesToStop.push(resource.name);
      }
    }
    for (let i = 0; i < patch.spec.resources.length; ++i) {
      if (resourcesToStop.includes(patch.spec.resources[i].name)) {
        patch.spec.resources[i].template.spec.vars.action_schedule.stop = stopTimestamp;
      }
    }
  }

  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    patch
  )) as ResourceClaim;
}

export async function scheduleStartForAllResourcesInResourceClaim(
  resourceClaim: ResourceClaim,
  date: Date,
  stopDate: Date
) {
  const startTimestamp = dateToApiString(date);
  const stopTimestamp = dateToApiString(stopDate);
  const patch = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  const resourcesToStart = [];
  for (const resource of resourceClaim.status?.resources) {
    if (canExecuteAction(resource.state, 'start')) {
      resourcesToStart.push(resource.name);
    }
  }
  for (let i = 0; i < patch.spec.resources.length; ++i) {
    if (resourcesToStart.includes(patch.spec.resources[i].name)) {
      patch.spec.resources[i].template.spec.vars.action_schedule.start = startTimestamp;
      patch.spec.resources[i].template.spec.vars.action_schedule.stop = stopTimestamp;
    }
  }

  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    patch
  )) as ResourceClaim;
}

export async function setLifespanEndForResourceClaim(
  resourceClaim: ResourceClaim,
  date: Date,
  updateResourceHandle = true
) {
  const endTimestamp = dateToApiString(date);
  const data = {
    spec: JSON.parse(JSON.stringify(resourceClaim.spec)),
  };
  let updatedMaxDate: string = null;
  let updatedRelativeMaxDate: string = null;
  if (resourceClaim.status?.lifespan?.maximum) {
    const maxDate = new Date(resourceClaim.metadata.creationTimestamp);
    maxDate.setDate(maxDate.getDate() + parseInt(resourceClaim.status.lifespan.maximum.slice(0, -1), 10));
    if (date.getTime() > maxDate.getTime()) {
      updatedMaxDate =
        Math.ceil(
          (date.getTime() - new Date(resourceClaim.metadata.creationTimestamp).getTime()) / (1000 * 60 * 60 * 24)
        ) +
        1 +
        'd';
    }
  }
  if (resourceClaim.status?.lifespan?.relativeMaximum) {
    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + parseInt(resourceClaim.status.lifespan.relativeMaximum.slice(0, -1), 10));
    if (date.getTime() > maxDate.getTime()) {
      updatedRelativeMaxDate = Math.ceil((date.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24)) + 1 + 'd';
    }
  }
  if (data.spec.lifespan) {
    data.spec.lifespan.end = endTimestamp;
  } else {
    data.spec.lifespan = { end: endTimestamp };
  }

  if (updateResourceHandle && (updatedMaxDate || updatedRelativeMaxDate)) {
    (await patchNamespacedCustomObject(
      'poolboy.gpte.redhat.com',
      'v1',
      resourceClaim.status.resourceHandle.namespace,
      'resourcehandles',
      resourceClaim.status.resourceHandle.name,
      {
        spec: {
          lifespan: {
            ...(updatedMaxDate
              ? {
                  maximum: `{% if resource_claim.annotations['demo.redhat.com/open-environment'] | default(false) | bool %}365d{% else %}${updatedMaxDate}{% endif %}`,
                }
              : {}),
            ...(updatedRelativeMaxDate
              ? {
                  relativeMaximum: `{% if resource_claim.annotations['demo.redhat.com/open-environment'] | default(false) | bool %}365d{% else %}${updatedRelativeMaxDate}{% endif %}`,
                }
              : {}),
          },
        },
      }
    )) as ResourceHandle;
  }

  return (await patchNamespacedCustomObject(
    'poolboy.gpte.redhat.com',
    'v1',
    resourceClaim.metadata.namespace,
    'resourceclaims',
    resourceClaim.metadata.name,
    data
  )) as ResourceClaim;
}

export async function startAllResourcesInResourceClaim(resourceClaim: ResourceClaim): Promise<ResourceClaim> {
  const defaultRuntimes = resourceClaim.status?.resources
    ? resourceClaim.status.resources.map((r) =>
        parseDuration(r.state?.spec.vars.action_schedule?.default_runtime || '4h')
      )
    : [];
  const defaultRuntime = defaultRuntimes.length > 0 ? Math.min(...defaultRuntimes) : 0;
  const startDate = new Date();
  const stopDate = new Date(Date.now() + defaultRuntime);
  return scheduleStartForAllResourcesInResourceClaim(resourceClaim, startDate, stopDate);
}

export async function stopAllResourcesInResourceClaim(resourceClaim: ResourceClaim) {
  const stopDate = new Date();
  return scheduleStopForAllResourcesInResourceClaim(resourceClaim, stopDate);
}

async function deleteNamespacedCustomObject(
  group: string,
  version: string,
  namespace: string,
  plural: string,
  name: string
): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`, {
    method: 'DELETE',
  });
  return await resp.json();
}

async function getNamespacedCustomObject(
  group: string,
  version: string,
  namespace: string,
  plural: string,
  name: string
): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`);
  return await resp.json();
}

async function listK8sObjects(opt: K8sObjectListOpt): Promise<K8sObjectList> {
  const { apiVersion, namespace, plural } = opt;
  const urlSearchParams = new URLSearchParams();
  if (opt.continue) {
    urlSearchParams.set('continue', opt.continue);
  }
  if (opt.labelSelector) {
    urlSearchParams.set('labelSelector', opt.labelSelector);
  }
  if (opt.limit) {
    urlSearchParams.set('limit', opt.limit.toString());
  }
  const base_url = namespace
    ? `/apis/${apiVersion}/namespaces/${namespace}/${plural}`
    : `/apis/${apiVersion}/${plural}`;
  const resp = await apiFetch(`${base_url}?${urlSearchParams.toString()}`, {
    disableImpersonation: opt.disableImpersonation || false,
  });
  return await resp.json();
}

async function patchNamespacedCustomObject(
  group: string,
  version: string,
  namespace: string,
  plural: string,
  name: string,
  patch: Record<string, unknown>,
  patchType = 'merge'
): Promise<K8sObject> {
  const resp = await apiFetch(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    headers: {
      'Content-Type': 'application/' + patchType + '-patch+json',
    },
  });
  return await resp.json();
}

export async function getOpenStackServersForResourceClaim(resourceClaim: ResourceClaim) {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/servers`
  );
  return await resp.json();
}

export async function rebootOpenStackServer(resourceClaim: ResourceClaim, projectId: string, serverId: string) {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/reboot`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function startOpenStackServer(resourceClaim: ResourceClaim, projectId: string, serverId: string) {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/start`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function stopOpenStackServer(resourceClaim: ResourceClaim, projectId: string, serverId: string) {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function startOpenStackServerConsoleSession(
  resourceClaim: ResourceClaim,
  projectId: string,
  serverId: string
) {
  const resp = await apiFetch(
    `/api/service/${resourceClaim.metadata.namespace}/${resourceClaim.metadata.name}/openstack/server/${projectId}/${serverId}/console`,
    {
      method: 'POST',
      body: JSON.stringify({}),
      headers: {
        'Content-Type': 'application/json',
      },
    }
  );
  return await resp.json();
}

export async function updateK8sObject<Type extends K8sObject>(definition: Type): Promise<Type> {
  const plural = definition.kind.toLowerCase() + 's';
  const path = definition.metadata.namespace
    ? `/apis/${definition.apiVersion}/namespaces/${definition.metadata.namespace}/${plural}/${definition.metadata.name}`
    : `/apis/${definition.apiVersion}/${plural}/${definition.metadata.name}`;

  const resp = await apiFetch(path, {
    body: JSON.stringify(definition),
    headers: {
      'Content-Type': 'application/json',
    },
    method: 'PUT',
  });
  return await resp.json();
}

export async function updateWorkshop(workshop: Workshop) {
  return updateK8sObject(workshop);
}

export async function fetchWithUpdatedCostTracker({
  path,
  initialResourceClaim,
}: {
  path: string;
  initialResourceClaim: ResourceClaim;
}): Promise<ResourceClaim> {
  const FIVE_MINUTES_MS = 300000;
  const initialCostTracker = getCostTracker(initialResourceClaim);
  if (initialCostTracker) {
    const lastUpdate = initialCostTracker.lastUpdate;
    if (!lastUpdate || compareStringDates(lastUpdate, new Date().toISOString()) > FIVE_MINUTES_MS) {
      const patch = {
        metadata: {
          annotations: {
            [`${BABYLON_DOMAIN}/cost-tracker`]: JSON.stringify({
              ...initialCostTracker,
              lastRequest: new Date().toISOString().replace(/\.[0-9]{3}/, ''), // remove milliseconds
            }),
          },
        },
      };
      await patchK8sObjectByPath({
        path,
        patch,
      });
      let resourceClaim = initialResourceClaim;
      let costTracker = initialCostTracker;
      while (costTracker.lastUpdate === initialCostTracker.lastUpdate) {
        resourceClaim = await fetcher(path);
        costTracker = getCostTracker(resourceClaim);
      }
      return resourceClaim;
    }
  }
  return await fetcher(path);
}

export function setProvisionRating(
  provisionUuid: string,
  rating: number,
  comment: string,
  useful: 'yes' | 'no' | 'not applicable'
) {
  return apiFetch(apiPaths.PROVISION_RATING({ provisionUuid }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating, comment, useful }),
  });
}

export const SERVICES_KEY = ({ namespace }: { namespace: string }) => `services/${namespace}`;

export const apiPaths: { [key in ResourceType]: (args: any) => string } = {
  CATALOG_ITEM: ({ namespace, name }: { namespace: string; name: string }): string =>
    `/apis/${BABYLON_DOMAIN}/v1/namespaces/${namespace}/catalogitems/${name}`,
  CATALOG_ITEMS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace: string;
    labelSelector?: string;
    limit?: number;
    continueId?: string;
  }) =>
    `/apis/${BABYLON_DOMAIN}/v1/namespaces/${namespace}/catalogitems?limit=${limit}${
      continueId ? `&continue=${continueId}` : ''
    }${labelSelector ? `&labelSelector=${labelSelector}` : ''}`,
  RESOURCE_CLAIMS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace?: string;
    limit: number;
    continueId?: string;
    labelSelector?: string;
  }) =>
    `/apis/poolboy.gpte.redhat.com/v1${namespace ? `/namespaces/${namespace}` : ''}/resourceclaims?limit=${limit}${
      continueId ? `&continue=${continueId}` : ''
    }${labelSelector ? `&labelSelector=${labelSelector}` : ''}`,
  RESOURCE_CLAIM: ({ namespace, resourceClaimName }: { namespace: string; resourceClaimName: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/${namespace}/resourceclaims/${resourceClaimName}`,
  NAMESPACES: ({ labelSelector, limit, continueId }: { labelSelector?: string; limit?: number; continueId?: string }) =>
    `/api/v1/namespaces?${labelSelector ? `labelSelector=${labelSelector}` : ''}${limit ? `&limit=${limit}` : ''}${
      continueId ? `&continue=${continueId}` : ''
    }`,
  WORKSHOP: ({ namespace, workshopName }: { namespace: string; workshopName: string }) =>
    `/apis/${BABYLON_DOMAIN}/v1/namespaces/${namespace}/workshops/${workshopName}`,
  WORKSHOPS: ({ namespace, limit, continueId }: { namespace?: string; limit?: number; continueId?: string }) =>
    `/apis/${BABYLON_DOMAIN}/v1${namespace ? `/namespaces/${namespace}` : ''}/workshops?${
      limit ? `limit=${limit}` : ''
    }${continueId ? `&continue=${continueId}` : ''}`,
  WORKSHOP_PROVISIONS: ({
    workshopName,
    namespace,
    limit,
    continueId,
  }: {
    workshopName: string;
    namespace: string;
    limit?: number;
    continueId?: string;
  }) =>
    `/apis/${BABYLON_DOMAIN}/v1/namespaces/${namespace}/workshopprovisions?labelSelector=babylon.gpte.redhat.com/workshop=${workshopName}${
      limit ? `&limit=${limit}` : ''
    }${continueId ? `&continue=${continueId}` : ''}`,
  RESOURCE_HANDLE: ({ resourceHandleName }: { resourceHandleName: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourcehandles/${resourceHandleName}`,
  RESOURCE_HANDLES: ({
    labelSelector,
    limit,
    continueId,
  }: {
    labelSelector?: string;
    limit?: number;
    continueId?: string;
  }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourcehandles?${
      labelSelector ? `labelSelector=${labelSelector}` : ''
    }${limit ? `&limit=${limit}` : ''}${continueId ? `&continue=${continueId}` : ''}`,
  RESOURCE_POOL: ({ resourcePoolName }: { resourcePoolName: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourcepools/${resourcePoolName}`,
  RESOURCE_POOLS: ({ limit, continueId }: { limit: number; continueId?: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourcepools?${limit ? `limit=${limit}` : ''}${
      continueId ? `&continue=${continueId}` : ''
    }`,
  RESOURCE_PROVIDERS: ({ limit, continueId }: { limit: number; continueId?: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourceproviders?${limit ? `limit=${limit}` : ''}${
      continueId ? `&continue=${continueId}` : ''
    }`,
  RESOURCE_PROVIDER: ({ resourceProviderName }: { resourceProviderName: string }) =>
    `/apis/poolboy.gpte.redhat.com/v1/namespaces/poolboy/resourceproviders/${resourceProviderName}`,
  PROVISION_RATING: ({ provisionUuid }: { provisionUuid: string }) => `/api/ratings/provisions/${provisionUuid}`,
  ANARCHY_RUNS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace?: string;
    limit?: number;
    continueId?: string;
    labelSelector?: string;
  }) =>
    `/apis/anarchy.gpte.redhat.com/v1/${namespace ? `namespaces/${namespace}/` : ''}anarchyruns?${
      labelSelector ? `labelSelector=${labelSelector}&` : ''
    }${limit ? `limit=${limit}` : ''}${continueId ? `&continue=${continueId}` : ''}`,
  ANARCHY_RUN: ({ namespace, anarchyRunName }: { namespace: string; anarchyRunName: string }) =>
    `/apis/anarchy.gpte.redhat.com/v1/namespaces/${namespace}/anarchyruns/${anarchyRunName}`,
  ANARCHY_SUBJECT: ({ namespace, anarchySubjectName }: { namespace: string; anarchySubjectName: string }) =>
    `/apis/anarchy.gpte.redhat.com/v1/namespaces/${namespace}/anarchysubjects/${anarchySubjectName}`,
  ANARCHY_SUBJECTS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace?: string;
    limit?: number;
    continueId?: string;
    labelSelector?: string;
  }) =>
    `/apis/anarchy.gpte.redhat.com/v1/${namespace ? `namespaces/${namespace}/` : ''}anarchysubjects?${
      labelSelector ? `labelSelector=${labelSelector}&` : ''
    }${limit ? `limit=${limit}` : ''}${continueId ? `&continue=${continueId}` : ''}`,
  ANARCHY_ACTION: ({ namespace, anarchyActionName }: { namespace: string; anarchyActionName: string }) =>
    `/apis/anarchy.gpte.redhat.com/v1/namespaces/${namespace}/anarchyactions/${anarchyActionName}`,
  ANARCHY_ACTIONS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace?: string;
    limit?: number;
    continueId?: string;
    labelSelector?: string;
  }) =>
    `/apis/anarchy.gpte.redhat.com/v1/${namespace ? `namespaces/${namespace}/` : ''}anarchyactions?${
      labelSelector ? `labelSelector=${labelSelector}&` : ''
    }${limit ? `limit=${limit}` : ''}${continueId ? `&continue=${continueId}` : ''}`,
  ANARCHY_GOVERNORS: ({
    namespace,
    limit,
    continueId,
    labelSelector,
  }: {
    namespace?: string;
    limit?: number;
    continueId?: string;
    labelSelector?: string;
  }) =>
    `/apis/anarchy.gpte.redhat.com/v1/${namespace ? `namespaces/${namespace}/` : ''}anarchygovernors?${
      labelSelector ? `labelSelector=${labelSelector}&` : ''
    }${limit ? `limit=${limit}` : ''}${continueId ? `&continue=${continueId}` : ''}`,
  ANARCHY_GOVERNOR: ({ namespace, anarchyGovernorName }: { namespace: string; anarchyGovernorName: string }) =>
    `/apis/anarchy.gpte.redhat.com/v1/namespaces/${namespace}/anarchygovernors/${anarchyGovernorName}`,
  INCIDENTS: ({ status }: { status?: string }) => `/api/admin/incidents${status ? '?status=' + status : ''}`,
  INCIDENT: ({ incidentId }: { incidentId: number }) => `/api/admin/incidents/${incidentId}`,
};
