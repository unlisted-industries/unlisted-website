import argparse
import csv
import json
import os
import re
from collections import defaultdict
from datetime import datetime
from decimal import Decimal
from pathlib import Path


def read_export(path, required):
    with path.open(encoding='utf-8-sig', newline='') as file:
        reader = csv.DictReader(file)
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f'{path.name} is missing required Shopify columns.')
        return [{key: value.strip() for key, value in row.items() if key and value} for row in reader]


def timestamp(value):
    return int(datetime.fromisoformat(value).timestamp()) if value else None


def grouped(rows, field):
    result = defaultdict(list)
    for row in rows:
        result[row[field]].append(row)
    return result


def option_key(values):
    options = (re.sub(r'\s*/\s*', '/', value.strip().casefold()) for value in values if value.strip())
    return tuple('s/m' if value == 's-m' else value for value in options)


def variant_key(row):
    return row['Handle'], option_key(row.get(f'Option{index} Value', '') for index in range(1, 4))


def prepare(directory):
    orders = read_export(directory / 'orders.csv', {'Id', 'Name', 'Created at', 'Currency', 'Total', 'Lineitem name'})
    customers = read_export(directory / 'customers.csv', {'Customer ID', 'First Name', 'Last Name', 'Email'})
    products = read_export(directory / 'products.csv', {'Handle', 'Variant Price', 'Variant SKU', 'Option1 Value'})
    inventory = read_export(directory / 'inventory.csv', {'Handle', 'Option1 Value', 'Location', 'Available (not editable)'})
    discount_file = directory / 'discounts.csv'
    discounts = read_export(discount_file, {'Name', 'Type', 'Status'}) if discount_file.is_file() else []
    order_records = []
    for number, rows in grouped(orders, 'Name').items():
        header = next(row for row in rows if row.get('Id'))
        lines = [{
            'name': row['Lineitem name'], 'sku': row.get('Lineitem sku', ''),
            'quantity': int(row['Lineitem quantity']), 'price': row.get('Lineitem price', ''),
        } for row in rows if row.get('Lineitem name')]
        order_records.append({
            'id': header['Id'], 'number': number, 'email': header.get('Email', '').lower() or None,
            'created': timestamp(header['Created at']), 'cancelled': timestamp(header.get('Cancelled at')),
            'payment': header.get('Financial Status', ''), 'fulfillment': header.get('Fulfillment Status', ''),
            'amount': format(Decimal(header['Total']), '.2f'), 'currency': header['Currency'], 'items': lines,
            'details': {'header': header, 'rows': rows},
        })
    customer_records = [{
        'id': row['Customer ID'], 'email': row.get('Email', '').lower() or None,
        'name': ' '.join(value for value in (row.get('First Name'), row.get('Last Name')) if value),
        'details': row,
    } for row in customers]

    catalog = json.loads((Path(__file__).resolve().parents[1] / 'data/shopify-public.json').read_text())
    target = {(product['handle'], option_key(variant['options'])): variant for product in catalog['products'] for variant in product['variants']}
    available = defaultdict(int)
    seen = set()
    for row in inventory:
        key = variant_key(row)
        location = key, row['Location']
        if location in seen:
            raise ValueError('The stock export repeats a variant in one location.')
        seen.add(location)
        if row.get('Available (not editable)', '').lstrip('-').isdigit():
            available[key] += int(row['Available (not editable)'])

    variants = []
    for row in products:
        if not row.get('Variant Price'):
            continue
        key = variant_key(row)
        if key not in target:
            raise ValueError('A Shopify variant has no matching catalog entry. Review the product export before importing stock.')
        stock = available.get(key) if row.get('Variant Inventory Policy') != 'continue' else None
        variants.append({
            'id': str(target[key]['id']), 'handle': key[0], 'sku': row.get('Variant SKU', ''),
            'available': max(0, stock) if stock is not None else None,
        })
    if len({variant['id'] for variant in variants}) != len(variants):
        raise ValueError('The product export has duplicate variants.')
    return {
        'version': 1, 'exportedAt': int(min(path.stat().st_mtime for path in (directory / (key + '.csv')
            for key in ('orders', 'customers', 'products', 'inventory')))),
        'orders': order_records, 'customers': customer_records,
        'products': [{'handle': handle, 'details': rows} for handle, rows in grouped(products, 'Handle').items()],
        'variants': variants,
        'discounts': discounts,
    }


def main():
    parser = argparse.ArgumentParser(description='Prepare a private UNLISTED migration upload from Shopify CSV exports.')
    parser.add_argument('exports', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    try:
        bundle = prepare(args.exports)
        with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w', encoding='utf-8') as file:
            json.dump(bundle, file, ensure_ascii=False, separators=(',', ':'))
    except (KeyError, ValueError, ArithmeticError, StopIteration, OSError) as error:
        parser.exit(1, f'Could not prepare the Shopify export ({type(error).__name__}). Check its format and destination.\n')
    print(f"Prepared {len(bundle['orders'])} orders, {len(bundle['customers'])} customers, {len(bundle['products'])} products, "
          f"{sum(row['available'] is not None for row in bundle['variants'])} stock balances, and {len(bundle['discounts'])} promotion rules.")


if __name__ == '__main__':
    main()
