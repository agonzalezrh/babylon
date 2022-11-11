import React from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Badge, CardBody, CardHeader, Split, SplitItem, Title, Tooltip } from '@patternfly/react-core';
import { CatalogItem } from '@app/types';
import CatalogItemIcon from './CatalogItemIcon';
import {
  formatString,
  getDescription,
  getIsDisabled,
  getProvider,
  getStage,
  getStatus,
  getSupportType,
} from './catalog-utils';
import StatusPageIcons from '@app/components/StatusPageIcons';
import { displayName, renderContent, stripHtml } from '@app/util';

import './catalog-item-card.css';
import EnterprisePremiumIcon from '@app/Support/EnterprisePremiumIcon';

const CatalogItemCard: React.FC<{ catalogItem: CatalogItem }> = ({ catalogItem }) => {
  const location = useLocation();
  const { namespace } = useParams();
  const urlSearchParams = new URLSearchParams(location.search);
  const { description, descriptionFormat } = getDescription(catalogItem);
  const provider = getProvider(catalogItem);
  const stage = getStage(catalogItem);
  const isDisabled = getIsDisabled(catalogItem);
  const { code: status } = getStatus(catalogItem);
  const supportType = getSupportType(catalogItem);

  if (!urlSearchParams.has('item')) {
    if (namespace) {
      urlSearchParams.set('item', catalogItem.metadata.name);
    } else {
      urlSearchParams.set('item', `${catalogItem.metadata.namespace}/${catalogItem.metadata.name}`);
    }
  }

  return (
    <div className="catalog-item-card__wrapper">
      {supportType && stage === 'prod' ? (
        <Tooltip content={<p>{supportType.replace(/_+/g, ' ')}</p>}>
          <a href="/support" className="catalog-item-card__support-type">
            {supportType === 'Enterprise_Premium' ? (
              <EnterprisePremiumIcon className="catalog-iten-card__support-type-icon catalog-iten-card__support-type-icon--enterprise-premium" />
            ) : null}
          </a>
        </Tooltip>
      ) : null}
      <Link
        className={`catalog-item-card ${isDisabled ? 'catalog-item-card--disabled' : ''}`}
        to={`${location.pathname}?${urlSearchParams.toString()}`}
      >
        <CardHeader className="catalog-item-card__header">
          <Split>
            <SplitItem>
              <CatalogItemIcon catalogItem={catalogItem} />
              {status && status !== 'operational' ? (
                <StatusPageIcons status={status} className="catalog-item-card__statusPageIcon" />
              ) : null}
            </SplitItem>
            <SplitItem className="catalog-item-card__badges" isFilled>
              {stage === 'dev' ? (
                <Badge className="catalog-item-card__badges--dev">development</Badge>
              ) : stage === 'test' ? (
                <Badge className="catalog-item-card__badges--test">test</Badge>
              ) : null}
            </SplitItem>
          </Split>
        </CardHeader>
        <CardBody className="catalog-item-card__body">
          <Title className="catalog-item-card__title" headingLevel="h3">
            {displayName(catalogItem)}
          </Title>
          <Title className="catalog-item-card__subtitle" headingLevel="h6">
            provided by {formatString(provider)}
          </Title>
          <div className="catalog-item-card__description">
            {description
              ? stripHtml(renderContent(description, { format: descriptionFormat })).slice(0, 150)
              : 'No description available.'}
          </div>
        </CardBody>
      </Link>
    </div>
  );
};

export default CatalogItemCard;
