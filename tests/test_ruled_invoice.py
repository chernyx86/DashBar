import unittest
from decimal import Decimal

from ruled_invoice import best_value, reconcile_row


class PrintedAmountsTest(unittest.TestCase):
    def test_uses_the_observed_pack_count_matching_net_price(self):
        row = {}
        reconcile_row(row, {
            'qty': {Decimal('3000'): 3, Decimal('3'): 1},
            'netPrice': {Decimal('12'): 2},
            'netSum': {Decimal('36'): 2},
            'vat': {Decimal('7.2'): 1},
            'gross': {Decimal('43.2'): 1, Decimal('143.2'): 2},
        })
        self.assertEqual(row['qty'], '3')
        self.assertEqual(row['gross'], '43.2')

    def test_missing_quantity_stays_empty_even_if_derivable(self):
        row = {}
        reconcile_row(row, {'qty': {}, 'netPrice': {Decimal('12'): 1},
                            'netSum': {Decimal('36'): 1}})
        self.assertEqual(row['qty'], '')
        self.assertEqual(best_value({Decimal('0.00'): 1}), '0.00')
