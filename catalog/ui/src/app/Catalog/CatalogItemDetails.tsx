import React, { useMemo } from 'react';
import parseDuration from 'parse-duration';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  DescriptionList,
  DescriptionListTerm,
  DescriptionListGroup,
  DescriptionListDescription,
  DrawerActions,
  DrawerCloseButton,
  DrawerContentBody,
  DrawerHead,
  DrawerPanelContent,
  PageSection,
  PageSectionVariants,
  Sidebar,
  SidebarContent,
  SidebarPanel,
  Split,
  SplitItem,
  Title,
  Label,
  Tooltip,
} from '@patternfly/react-core';
import InfoAltIcon from '@patternfly/react-icons/dist/js/icons/info-alt-icon';
import useSWR from 'swr';
import { apiPaths, fetcherItemsInAllPages } from '@app/api';
import { CatalogItem, ResourceClaim } from '@app/types';
import LoadingIcon from '@app/components/LoadingIcon';
import StatusPageIcons from '@app/components/StatusPageIcons';
import useSession from '@app/utils/useSession';
import useImpersonateUser from '@app/utils/useImpersonateUser';
import {
  checkAccessControl,
  displayName,
  renderContent,
  BABYLON_DOMAIN,
  FETCH_BATCH_LIMIT,
  isLabDeveloper,
  getHelpUrl,
  isResourceClaimPartOfWorkshop,
  compareK8sObjectsArr,
  CATALOG_MANAGER_DOMAIN,
} from '@app/util';
import StarRating from '@app/components/StarRating';
import TimeInterval from '@app/components/TimeInterval';
import ShareLink from '@app/components/ShareLink';
import {
  getProvider,
  getDescription,
  formatTime,
  getIsDisabled,
  getStatus,
  HIDDEN_LABELS_DETAIL_VIEW,
  getIncidentUrl,
  formatString,
  getRating,
  CUSTOM_LABELS,
  sortLabels,
  formatCurrency,
  getLastSuccessfulProvisionTime,
} from './catalog-utils';
import CatalogItemIcon from './CatalogItemIcon';
import CatalogItemHealthDisplay from './CatalogItemHealthDisplay';

import './catalog-item-details.css';

enum CatalogItemAccess {
  Allow,
  Deny,
  RequestInformation,
}

const CatalogItemDetails: React.FC<{ catalogItem: CatalogItem; onClose: () => void }> = ({ catalogItem, onClose }) => {
  const navigate = useNavigate();
  const { email, userNamespace, isAdmin, groups } = useSession().getSession();
  const { userImpersonated } = useImpersonateUser();
  const { provisionTimeEstimate, accessControl, lastUpdate } = catalogItem.spec;
  const { labels, namespace, name } = catalogItem.metadata;
  const provider = getProvider(catalogItem);
  const catalogItemName = displayName(catalogItem);
  const { description, descriptionFormat } = getDescription(catalogItem);
  const lastSuccessfulProvisionTime = getLastSuccessfulProvisionTime(catalogItem);
  const displayProvisionTime = provisionTimeEstimate && formatTime(provisionTimeEstimate);

  const { data: userResourceClaims } = useSWR<ResourceClaim[]>(
    userNamespace?.name
      ? apiPaths.RESOURCE_CLAIMS({
          namespace: userNamespace.name,
          limit: 'ALL',
        })
      : null,
    () =>
      fetcherItemsInAllPages((continueId) =>
        apiPaths.RESOURCE_CLAIMS({
          namespace: userNamespace.name,
          limit: FETCH_BATCH_LIMIT,
          continueId,
        }),
      ),
    {
      refreshInterval: 8000,
      compare: compareK8sObjectsArr,
    },
  );

  const services: ResourceClaim[] = useMemo(
    () =>
      Array.isArray(userResourceClaims)
        ? [].concat(...userResourceClaims.filter((r) => !isResourceClaimPartOfWorkshop(r)))
        : [],
    [userResourceClaims],
  );

  const descriptionHtml = useMemo(
    () => (
      <div
        className="catalog-item-details__description"
        dangerouslySetInnerHTML={{
          __html: description ? renderContent(description, { format: descriptionFormat }) : 'No description available.',
        }}
      />
    ),
    [description, descriptionFormat],
  );

  const isDisabled = getIsDisabled(catalogItem);
  const { code: statusCode, name: statusName } = getStatus(catalogItem);
  const incidentUrl = getIncidentUrl(catalogItem);
  const rating = getRating(catalogItem);
  const accessCheckResult = checkAccessControl(accessControl, groups, isAdmin);
  let autoStopTime = catalogItem.spec.runtime?.default;
  const autoDestroyTime = catalogItem.spec.lifespan?.default;
  if (autoStopTime && autoDestroyTime) {
    const autoStopTimeValue = parseDuration(autoStopTime);
    const autoDestroyTimeValue = parseDuration(autoDestroyTime);
    if (autoStopTimeValue === autoDestroyTimeValue || autoStopTimeValue > autoDestroyTimeValue) {
      autoStopTime = null;
    }
  }
  const catalogItemAccess: CatalogItemAccess =
    isAdmin || isLabDeveloper(groups)
      ? CatalogItemAccess.Allow
      : accessCheckResult === 'deny'
      ? CatalogItemAccess.Deny
      : services.length >= 5
      ? CatalogItemAccess.Deny
      : accessCheckResult === 'allow'
      ? CatalogItemAccess.Allow
      : CatalogItemAccess.RequestInformation;
  const catalogItemAccessDenyReason =
    catalogItemAccess !== CatalogItemAccess.Deny ? null : services.length >= 5 ? (
      <p>
        You have reached your quota of 5 services. You will not be able to request any new applications until you retire
        existing services. If you feel this is an error, please{' '}
        <a href={getHelpLink()} target="_blank" rel="noopener noreferrer">
          contact us
        </a>
        .
      </p>
    ) : (
      <p>Access denied by catalog item configuration.</p>
    );

  const attributes: { [attr: string]: string } = {};
  for (const [label, value] of Object.entries(labels || {})) {
    if (label.startsWith(`${BABYLON_DOMAIN}/`)) {
      const attr = label.substring(BABYLON_DOMAIN.length + 1);
      if (!HIDDEN_LABELS_DETAIL_VIEW.includes(attr)) {
        attributes[attr] = value;
      }
    }
    if (label.startsWith(`${CATALOG_MANAGER_DOMAIN}/`)) {
      const attr = label.substring(CATALOG_MANAGER_DOMAIN.length + 1);
      if (!HIDDEN_LABELS_DETAIL_VIEW.includes(attr)) {
        attributes[attr] = value;
      }
    }
  }

  async function orderCatalogItem() {
    navigate(`/catalog/${namespace}/order/${name}`);
  }

  function getHelpLink() {
    const userEmail = userImpersonated ? userImpersonated : email;
    return getHelpUrl(userEmail);
  }

  function requestInformation() {
    window.open(getHelpLink(), '_blank');
  }

  return (
    <DrawerPanelContent
      className="catalog-item-details"
      widths={{ default: 'width_75', lg: 'width_75', xl: 'width_66', '2xl': 'width_50' }}
    >
      <DrawerHead>
        <DrawerActions>
          <DrawerCloseButton onClick={onClose} />
        </DrawerActions>
        <Split hasGutter>
          <SplitItem className="catalog-item-details__header-icon">
            <CatalogItemIcon catalogItem={catalogItem} />
          </SplitItem>
          <SplitItem isFilled className="catalog-item-details__header-text">
            <Title className="catalog-item-details__title" headingLevel="h1">
              {catalogItemName}
            </Title>
            {provider ? (
              <Title className="catalog-item-details__subtitle" headingLevel="h4">
                provided by {formatString(provider)}
              </Title>
            ) : null}
          </SplitItem>
        </Split>
        <PageSection variant={PageSectionVariants.light} className="catalog-item-details__actions">
          {catalogItemAccess === CatalogItemAccess.Allow ? (
            <>
              <Button
                key="order-catalog-item"
                onClick={orderCatalogItem}
                variant="primary"
                isDisabled={isAdmin ? false : isDisabled}
                className="catalog-item-details__main-btn"
              >
                Order
              </Button>
              {isAdmin ? (
                <Button
                  key="catalog-item-admin"
                  onClick={() => navigate(`/admin/catalogitems/${namespace}/${name}`)}
                  variant="secondary"
                >
                  Admin
                </Button>
              ) : null}
              <ShareLink
                url={
                  new URL(
                    `/catalog?item=${catalogItem.metadata.namespace}/${catalogItem.metadata.name}`,
                    window.location.origin,
                  )
                }
                name={catalogItemName}
              />
              {statusCode && statusCode !== 'operational' ? (
                <div className="catalog-item-details__status">
                  <Label
                    className={`catalog-item-details__status--${statusCode}`}
                    variant="outline"
                    render={({ className, content }) =>
                      incidentUrl ? (
                        <a href={incidentUrl} target="_blank" rel="noreferrer" className={className}>
                          {content}
                        </a>
                      ) : (
                        <p className={className}>{content}</p>
                      )
                    }
                    icon={<StatusPageIcons style={{ width: '20px' }} status={statusCode} />}
                  >
                    {statusName}
                  </Label>
                </div>
              ) : null}
            </>
          ) : catalogItemAccess === CatalogItemAccess.Deny ? (
            <>
              <Button key="button" isDisabled variant="primary" className="catalog-item-details__main-btn">
                Order
              </Button>
              <div key="reason" className="catalog-item-details__access-deny-reason">
                {catalogItemAccessDenyReason}
              </div>
            </>
          ) : catalogItemAccess === CatalogItemAccess.RequestInformation ? (
            <Button onClick={requestInformation} variant="primary" className="catalog-item-details__main-btn--expanded">
              Request Information
            </Button>
          ) : (
            <LoadingIcon className="catalog-item-details__actions--loading" />
          )}
        </PageSection>
      </DrawerHead>
      <DrawerContentBody className="catalog-item-details__body">
        <Sidebar>
          <SidebarPanel className="catalog-item-details__sidebar">
            <DescriptionList>
              {catalogItem.status?.provisionHistory ? (
                <DescriptionListGroup>
                  <DescriptionListTerm>Health</DescriptionListTerm>
                  <DescriptionListDescription>
                    <CatalogItemHealthDisplay provisionHistory={catalogItem.status.provisionHistory} />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
              {Object.entries(attributes)
                .sort(sortLabels)
                .map(([attr, value]) => (
                  <DescriptionListGroup key={attr}>
                    <DescriptionListTerm>
                      {formatString(attr)}
                      {attr === CUSTOM_LABELS.ESTIMATED_COST.key ? (
                        <Tooltip content="Estimated hourly cost per instance">
                          <InfoAltIcon
                            style={{
                              paddingTop: 'var(--pf-global--spacer--xs)',
                              marginLeft: 'var(--pf-global--spacer--sm)',
                              width: 'var(--pf-global--icon--FontSize--sm)',
                            }}
                          />
                        </Tooltip>
                      ) : null}
                    </DescriptionListTerm>
                    <DescriptionListDescription>
                      {attr === CUSTOM_LABELS.RATING.key ? (
                        <StarRating count={5} rating={rating?.ratingScore} total={rating?.totalRatings} readOnly />
                      ) : attr === CUSTOM_LABELS.SLA.key ? (
                        <Link to="/support">{formatString(value)}</Link>
                      ) : attr === CUSTOM_LABELS.ESTIMATED_COST.key ? (
                        formatCurrency(parseFloat(value))
                      ) : (
                        formatString(value)
                      )}
                    </DescriptionListDescription>
                  </DescriptionListGroup>
                ))}

              {provisionTimeEstimate ? (
                <DescriptionListGroup className="catalog-item-details__estimated-time">
                  <DescriptionListTerm>Estimated provision time</DescriptionListTerm>
                  <DescriptionListDescription>
                    {displayProvisionTime !== '-' ? `Up to ${displayProvisionTime}` : displayProvisionTime}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}

              {lastUpdate && lastUpdate.git ? (
                <DescriptionListGroup className="catalog-item-details__last-update">
                  <DescriptionListTerm>Last update</DescriptionListTerm>
                  <DescriptionListDescription>
                    {isAdmin || isLabDeveloper(groups) ? (
                      <a
                        href={`https://github.com/rhpds/agnosticv/commit/${lastUpdate.git.hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <TimeInterval toTimestamp={lastUpdate.git.when_committer} />
                      </a>
                    ) : (
                      <TimeInterval toTimestamp={lastUpdate.git.when_committer} />
                    )}
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}

              {lastSuccessfulProvisionTime ? (
                <DescriptionListGroup className="catalog-item-details__last-provision">
                  <DescriptionListTerm>Last successful provision</DescriptionListTerm>
                  <DescriptionListDescription>
                    <TimeInterval toEpochMilliseconds={lastSuccessfulProvisionTime} />
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}

              {autoStopTime ? (
                <DescriptionListGroup className="catalog-item-details__auto-stop">
                  <DescriptionListTerm>Auto-Stop</DescriptionListTerm>
                  <DescriptionListDescription>
                    <TimeInterval interval={autoStopTime}></TimeInterval>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}

              {autoDestroyTime ? (
                <DescriptionListGroup className="catalog-item-details__auto-destroy">
                  <DescriptionListTerm>Auto-Destroy</DescriptionListTerm>
                  <DescriptionListDescription>
                    <TimeInterval interval={autoDestroyTime}></TimeInterval>
                  </DescriptionListDescription>
                </DescriptionListGroup>
              ) : null}
            </DescriptionList>
          </SidebarPanel>
          <SidebarContent>
            <p className="catalog-item-details__description-label">Description</p>
            {descriptionHtml}
          </SidebarContent>
        </Sidebar>
      </DrawerContentBody>
    </DrawerPanelContent>
  );
};

export default CatalogItemDetails;
