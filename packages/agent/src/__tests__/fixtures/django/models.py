from django.db import models

STATUS_CHOICES = [
    (0, 'Active'),
    (1, 'Banned'),
]

class User(models.Model):
    email = models.EmailField()
    status = models.IntegerField(choices=STATUS_CHOICES, default=0)

    class Meta:
        db_table = 'auth_user'

class Order(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    total = models.DecimalField(max_digits=10, decimal_places=2)

    class Meta:
        db_table = 'order_order'
