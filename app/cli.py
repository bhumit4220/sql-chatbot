import asyncio
import sys

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import hash_password
from app.models.admin import Admin


async def create_admin_in_db(session: AsyncSession, email: str, password: str) -> Admin:
    admin = Admin(email=email, password_hash=hash_password(password), role="owner")
    session.add(admin)
    await session.flush()
    return admin


async def main():
    if len(sys.argv) < 2:
        print("Usage: python -m app.cli create-admin --email <email>")
        sys.exit(1)

    command = sys.argv[1]
    if command == "create-admin":
        import argparse

        parser = argparse.ArgumentParser()
        parser.add_argument("command")
        parser.add_argument("--email", required=True)
        args = parser.parse_args()

        import getpass

        password = getpass.getpass("Password: ")

        from app.database import async_session_factory

        async with async_session_factory() as session:
            admin = await create_admin_in_db(session, args.email, password)
            await session.commit()
            print(f"Admin created: {admin.email} (id={admin.id})")
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
