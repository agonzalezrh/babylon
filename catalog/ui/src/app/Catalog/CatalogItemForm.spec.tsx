import React from 'react';
import { render, fireEvent, waitFor, generateSession } from '../utils/test-utils';
import CatalogItemForm from './CatalogItemForm';
import catalogItemObj from '../__mocks__/catalogItem.json';
import userEvent from '@testing-library/user-event';
import { CatalogItem } from '@app/types';
import useSession from '@app/utils/useSession';

jest.mock('@app/api', () => ({
  ...jest.requireActual('@app/api'),
  fetcher: () => Promise.resolve(catalogItemObj as CatalogItem),
}));

const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ namespace: 'babylon-catalog-test', name: 'tests.test-empty-config.prod' }),
  useNavigate: () => mockNavigate,
}));

jest.mock('@app/utils/useSession', () =>
  jest.fn(() => ({
    getSession: () => generateSession({}),
  }))
);

describe('CatalogItemForm Component', () => {
  test("When renders should display 'CatalogItem' properties and parameters", async () => {
    const { getByText, getByLabelText } = render(<CatalogItemForm />);
    const catalogItemDisplayName = await waitFor(() => getByText('Order Test Config'));
    const sfidLabel = getByLabelText('Salesforce ID');
    const purposeLabel = getByText('Purpose');
    const purposePlaceholder = '- Select Purpose -';
    const termsOfServiceLabel = getByText('IMPORTANT PLEASE READ');
    const termsOfServiceAck = 'I confirm that I understand the above warnings.';

    expect(catalogItemDisplayName).toBeInTheDocument();
    expect(sfidLabel).toBeInTheDocument();
    expect(purposeLabel.closest('.pf-c-form__group').textContent).toContain(purposePlaceholder);
    expect(termsOfServiceLabel.closest('.terms-of-service').textContent).toContain(termsOfServiceAck);
  });

  test('When Cancel button is clicked the history goBack function is called', async () => {
    const { getByText } = render(<CatalogItemForm />);
    const button = await waitFor(() => getByText('Cancel'));
    fireEvent.click(button);
    expect(mockNavigate).toHaveBeenCalled();
  });

  test('Submit button disabled until required fields are filled', async () => {
    const { getByText } = render(<CatalogItemForm />);
    const button = await waitFor(() => getByText('Order'));
    expect(button).toBeDisabled();

    const termsOfServiceAck = getByText('I confirm that I understand the above warnings.').parentElement.querySelector(
      'input[type="checkbox"]'
    );
    expect(termsOfServiceAck).not.toBeChecked();
    fireEvent.click(termsOfServiceAck);
    expect(termsOfServiceAck).toBeChecked();
    expect(button).toBeDisabled();

    await userEvent.click(getByText('- Select Purpose -').closest('button'));
    await userEvent.click(getByText('Development - Catalog item creation / maintenance'));
    expect(button).toBeEnabled();
  });

  test('Description should be visible when hovering', async () => {
    const { queryByText, getByLabelText } = render(<CatalogItemForm />);

    const sfidLabel = await waitFor(() => getByLabelText('Salesforce ID'));
    const sfidDescriptionText = 'Salesforce Opportunity ID, Campaign ID, or Partner Registration';
    expect(queryByText(sfidDescriptionText)).not.toBeInTheDocument();
    await userEvent.hover(sfidLabel.closest('.pf-c-form__group').querySelector('.tooltip-icon-only'));
    await waitFor(() => expect(queryByText(sfidDescriptionText)).toBeInTheDocument());
  });

  test('Enabling Workshop switch should display form', async () => {
    const { getByText, queryByText, getByLabelText } = render(<CatalogItemForm />);
    const switchBtn = await waitFor(() => getByLabelText('Enable workshop user interface'));

    const workshopItemDisplayName = 'Test Config';
    expect(queryByText('Display Name')).not.toBeInTheDocument();
    expect(queryByText('Password')).not.toBeInTheDocument();
    expect(queryByText('User Registration')).not.toBeInTheDocument();
    expect(queryByText('Description')).not.toBeInTheDocument();

    await userEvent.click(switchBtn);

    const input: HTMLInputElement = getByText('Display Name')
      .closest('.pf-c-form__group')
      .querySelector('input[type="text"]');
    expect(getByText('Display Name')).toBeInTheDocument();
    expect(input.value).toContain(workshopItemDisplayName);
    expect(getByText('Password')).toBeInTheDocument();
    expect(getByText('User Registration')).toBeInTheDocument();
    expect(getByText('Description')).toBeInTheDocument();
  });

  test('Workshop Title is required', async () => {
    const { getByText, getByLabelText } = render(<CatalogItemForm />);
    const button = await waitFor(() => getByText('Order'));
    const switchBtn = getByLabelText('Enable workshop user interface');

    expect(button).toBeDisabled();

    await userEvent.click(switchBtn);
    const termsOfServiceAck = getByText('I confirm that I understand the above warnings.').parentElement.querySelector(
      'input[type="checkbox"]'
    );
    fireEvent.click(termsOfServiceAck);
    await userEvent.click(getByText('- Select Purpose -').closest('button'));
    await userEvent.click(getByText('Development - Catalog item creation / maintenance'));

    expect(button).toBeEnabled();

    const input: HTMLInputElement = getByText('Display Name')
      .closest('.pf-c-form__group')
      .querySelector('input[type="text"]');
    await userEvent.clear(input);

    expect(button).toBeDisabled();
  });

  test('Workshop Feature disabled if user doesnt have workshopNamespaces', async () => {
    (useSession as jest.Mock).mockImplementation(() => ({
      getSession: () => generateSession({ workshopNamespaces: [] }),
    }));
    const { getByText, queryByLabelText } = render(<CatalogItemForm />);
    await waitFor(() => getByText('Order'));
    expect(queryByLabelText('Enable workshop user interface')).not.toBeInTheDocument();
  });
});
